import { type RunnerHandle, run } from '@grammyjs/runner';
import { Bot, type BotConfig, type Context } from 'grammy';
import type {
  OAuthLoginAttemptSnapshot,
  OAuthLoginInputKind,
  ProviderAuthStatus,
  ProviderCatalogEntry,
} from '../runtime/pi-auth.js';
import type { ThreadControlService } from '../runtime/pi-executor.js';
import type { RunService } from '../server/service.js';
import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import {
  normalizeTelegramMessageThreadId,
  type TelegramRoute,
  telegramThreadKeyFromRoute,
} from '../shared/telegram-threading.js';
import { TelegramBackgroundRunRegistry } from './telegram-background-run-registry.js';
import { buildTelegramAllowCommand, isTelegramUserAuthorized } from './telegram-polling-authz.js';
import { dispatchTelegramCallback, dispatchTelegramCommand } from './telegram-polling-dispatch.js';
import {
  callTelegramWithRetry,
  canonicalizeTelegramUserId,
  formatTaskTopicTitle,
  type ParsedTelegramCommand,
  parseTelegramCommand,
  routeFromMessageContext,
} from './telegram-polling-helpers.js';
import { TelegramPollingMessageFlow } from './telegram-polling-message-flow.js';
import {
  mapTelegramTopicCreationError,
  mapTelegramTopicDeletionError,
  readPrivateTopicsEnabledFromBotInfo,
} from './telegram-polling-topics.js';
import { TelegramRunDelivery } from './telegram-run-delivery.js';
import { TelegramRuntimeControls } from './telegram-runtime-controls.js';

const defaultPollIntervalMs = 500;
const defaultPollRequestTimeoutSeconds = 30;
const telegramMessageLimit = 3500;
const defaultTelegramApiRoot = 'https://api.telegram.org';

interface TelegramPollingAdapterOptions {
  botToken: string;
  runService: RunService;
  authService?: {
    getProviderCatalog(): ProviderCatalogEntry[];
    getProviderStatuses(): ProviderAuthStatus[];
    startOAuthLogin(provider: string, ownerKey: string): OAuthLoginAttemptSnapshot;
    getOAuthLoginAttempt(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null;
    submitOAuthLoginInput(
      attemptId: string,
      ownerKey: string,
      value: string,
      expectedKind?: OAuthLoginInputKind,
    ): OAuthLoginAttemptSnapshot;
    cancelOAuthLogin(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot;
  };
  threadControlService?: ThreadControlService;
  clearScheduledTaskExecutionThreadByKey?: (threadKey: string) => Promise<number>;
  allowedTelegramUserIds?: string[];
  workspaceDir?: string;
  pollIntervalMs?: number;
  telegramApiRoot?: string;
  pollRequestTimeoutSeconds?: number;
  botInfo?: BotConfig<Context>['botInfo'];
  logger?: Logger;
}

export class TelegramPollingAdapter {
  private readonly bot: Bot;
  private readonly runtimeControls: TelegramRuntimeControls;
  private runner: RunnerHandle | null = null;
  private readonly pollIntervalMs: number;
  private readonly pollRequestTimeoutSeconds: number;
  private readonly logger: Logger;
  private readonly allowedTelegramUserIds: Set<string>;
  private readonly workspaceDir: string | null;
  private readonly runDelivery: TelegramRunDelivery;
  private readonly messageFlow: TelegramPollingMessageFlow;
  private readonly backgroundRuns = new TelegramBackgroundRunRegistry();
  private privateTopicsEnabled: boolean | null = null;

  constructor(private readonly options: TelegramPollingAdapterOptions) {
    const botConfig: BotConfig<Context> = {};

    if (options.telegramApiRoot) {
      botConfig.client = {
        apiRoot: options.telegramApiRoot,
      };
    }

    if (options.botInfo) {
      botConfig.botInfo = options.botInfo;
    }

    this.bot = new Bot(options.botToken, botConfig);
    this.runtimeControls = new TelegramRuntimeControls({
      authService: options.authService,
      threadControlService: options.threadControlService,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.pollRequestTimeoutSeconds = options.pollRequestTimeoutSeconds ?? defaultPollRequestTimeoutSeconds;
    this.logger = options.logger ?? noopLogger;
    this.allowedTelegramUserIds = new Set((options.allowedTelegramUserIds ?? []).map(canonicalizeTelegramUserId));
    this.workspaceDir = options.workspaceDir ?? null;
    const telegramApiRoot = (options.telegramApiRoot ?? defaultTelegramApiRoot).replace(/\/$/u, '');
    this.runDelivery = new TelegramRunDelivery({
      bot: this.bot,
      runService: options.runService,
      logger: this.logger,
      pollIntervalMs: this.pollIntervalMs,
      messageLimit: telegramMessageLimit,
    });
    this.messageFlow = new TelegramPollingMessageFlow({
      bot: this.bot,
      botToken: options.botToken,
      telegramApiRoot,
      runService: options.runService,
      logger: this.logger,
      reply: (ctx, text) => this.reply(ctx, text),
      deliverRun: async (runId, route) => {
        await this.deliverRun(runId, route);
      },
    });

    this.bot.catch((error) => {
      this.logger.error({
        event: 'telegram_handler_error',
        message: error.error instanceof Error ? error.error.message : String(error.error),
      });
    });

    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });

    this.bot.on('message:photo', async (ctx) => {
      await this.handlePhotoMessage(ctx);
    });

    this.bot.on('message:document', async (ctx) => {
      await this.handleDocumentMessage(ctx);
    });

    this.bot.on('callback_query:data', async (ctx) => {
      await this.handleCallbackQuery(ctx);
    });
  }

  async start(): Promise<void> {
    if (this.runner) {
      return;
    }

    await this.bot.init();
    this.privateTopicsEnabled = readPrivateTopicsEnabledFromBotInfo(this.bot.botInfo);

    this.runner = run(this.bot, {
      runner: {
        fetch: {
          allowed_updates: ['message', 'callback_query'],
          timeout: this.pollRequestTimeoutSeconds,
        },
      },
    });

    void this.runner.task()?.catch((error) => {
      this.logger.error({
        event: 'telegram_runner_stopped_with_error',
        message: error instanceof Error ? error.message : String(error),
      });
    });

    const username = this.bot.botInfo.username;
    this.logger.info({
      event: 'telegram_polling_started',
      username,
      private_topics_enabled: this.privateTopicsEnabled,
    });

    if (this.privateTopicsEnabled === false) {
      this.logger.warn({
        event: 'telegram_private_topics_disabled',
        message:
          'Telegram private-chat topics are disabled for this bot. Scheduled task topic delivery requires topic mode.',
      });
    }
  }

  async stop(): Promise<void> {
    await this.backgroundRuns.abortAllAndWait();

    if (!this.runner) {
      return;
    }

    await this.runner.stop();
    this.runner = null;
    this.logger.info({ event: 'telegram_polling_stopped' });
  }

  async createTaskTopic(input: { chatId: number; taskId: string; title: string }): Promise<TelegramRoute> {
    await this.start();

    const { taskId, chatId, title } = input;

    this.logger.info({
      event: 'telegram_task_topic_create_requested',
      task_id: taskId,
      chat_id: chatId,
      private_topics_enabled: this.privateTopicsEnabled,
    });

    if (this.privateTopicsEnabled === false) {
      throw this.logTaskTopicCreateFailure(
        taskId,
        chatId,
        new Error(
          'telegram_topics_unavailable: Telegram private-chat topics are disabled for this bot; enable topics in BotFather and retry',
        ),
      );
    }

    let created: { message_thread_id?: number };

    try {
      created = (await callTelegramWithRetry(() =>
        this.bot.api.raw.createForumTopic({
          chat_id: chatId,
          name: formatTaskTopicTitle(taskId, title),
        }),
      )) as { message_thread_id?: number };
    } catch (error) {
      throw this.logTaskTopicCreateFailure(taskId, chatId, mapTelegramTopicCreationError(error));
    }

    let messageThreadId: number | undefined;
    try {
      messageThreadId = normalizeTelegramMessageThreadId(Number(created.message_thread_id));
    } catch {
      throw this.logTaskTopicCreateFailure(
        taskId,
        chatId,
        new Error('telegram_topics_unavailable: createForumTopic returned an invalid message_thread_id'),
      );
    }

    if (!messageThreadId) {
      throw this.logTaskTopicCreateFailure(
        taskId,
        chatId,
        new Error('telegram_topics_unavailable: createForumTopic returned an unsupported message_thread_id'),
      );
    }

    this.logger.info({
      event: 'telegram_task_topic_create_succeeded',
      task_id: taskId,
      chat_id: chatId,
      message_thread_id: messageThreadId,
    });

    return {
      chatId,
      messageThreadId,
    };
  }

  async syncTaskTopicTitle(route: TelegramRoute, taskId: string, title: string): Promise<void> {
    const messageThreadId = route.messageThreadId;
    if (!messageThreadId) {
      throw new Error('cannot sync Telegram topic title without message_thread_id');
    }

    await this.start();

    await callTelegramWithRetry(() =>
      this.bot.api.raw.editForumTopic({
        chat_id: route.chatId,
        message_thread_id: messageThreadId,
        name: formatTaskTopicTitle(taskId, title),
      }),
    );
  }

  async deliverRun(runId: string, route: TelegramRoute): Promise<void> {
    const threadKey = telegramThreadKeyFromRoute(route);

    this.logger.info({
      event: 'telegram_run_delivery_requested',
      run_id: runId,
      chat_id: route.chatId,
      message_thread_id: route.messageThreadId,
      thread_key: threadKey,
    });

    this.startBackgroundRunDelivery({
      runId,
      route,
      threadKey,
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await this.reply(ctx, 'Telegram adapter currently supports personal chats only.');
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }

    if (!isTelegramUserAuthorized(this.allowedTelegramUserIds, ctx.from?.id)) {
      await this.handleUnauthorizedTelegramAccess(ctx);
      return;
    }

    const command = parseTelegramCommand(text);
    if (command) {
      await this.handleCommand(ctx, command, text);
      return;
    }

    await this.handleAssistantMessage(ctx, text, 'followUp');
  }

  private async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      return;
    }

    if (!isTelegramUserAuthorized(this.allowedTelegramUserIds, ctx.from?.id)) {
      await this.handleUnauthorizedTelegramAccess(ctx);
      return;
    }

    await this.messageFlow.handlePhotoMessage(ctx);
  }

  private async handleDocumentMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      return;
    }

    if (!isTelegramUserAuthorized(this.allowedTelegramUserIds, ctx.from?.id)) {
      await this.handleUnauthorizedTelegramAccess(ctx);
      return;
    }

    await this.messageFlow.handleDocumentMessage(ctx);
  }

  private async handleCommand(ctx: Context, command: ParsedTelegramCommand, rawText: string): Promise<void> {
    await dispatchTelegramCommand({
      ctx,
      command,
      rawText,
      runtimeControls: this.runtimeControls,
      logger: this.logger,
      reply: (replyCtx, text) => this.reply(replyCtx, text),
      handleAssistantMessage: (assistantCtx, text, deliveryMode) =>
        this.handleAssistantMessage(assistantCtx, text, deliveryMode),
      handleDeleteTopicCommand: (deleteCtx) => this.handleDeleteTopicCommand(deleteCtx),
      onThreadCancelled: (cancelCtx) => {
        const route = routeFromMessageContext(cancelCtx);
        this.abortBackgroundRunsForThread(telegramThreadKeyFromRoute(route));
      },
    });
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await ctx.answerCallbackQuery({ text: 'This action is supported in personal chats only.' });
      return;
    }

    if (!isTelegramUserAuthorized(this.allowedTelegramUserIds, ctx.from?.id)) {
      await this.handleUnauthorizedTelegramAccess(ctx);
      try {
        await ctx.answerCallbackQuery({ text: 'Not authorized yet. Ask operator to allow your user id.' });
      } catch {
        // no-op: fallback chat reply from handleUnauthorizedTelegramAccess is sufficient
      }
      return;
    }

    await dispatchTelegramCallback({
      ctx,
      runtimeControls: this.runtimeControls,
      logger: this.logger,
      reply: (replyCtx, text) => this.reply(replyCtx, text),
    });
  }

  private async handleDeleteTopicCommand(ctx: Context): Promise<void> {
    const route = routeFromMessageContext(ctx);
    const messageThreadId = route.messageThreadId;
    if (!messageThreadId) {
      await this.reply(ctx, 'This command only works inside a Telegram topic thread.');
      return;
    }

    try {
      await callTelegramWithRetry(() =>
        this.bot.api.raw.deleteForumTopic({
          chat_id: route.chatId,
          message_thread_id: messageThreadId,
        }),
      );
    } catch (error) {
      throw mapTelegramTopicDeletionError(error);
    }

    const threadKey = telegramThreadKeyFromRoute(route);
    this.abortBackgroundRunsForThread(threadKey);

    let clearedTaskCount = 0;
    if (this.options.clearScheduledTaskExecutionThreadByKey) {
      clearedTaskCount = await this.options.clearScheduledTaskExecutionThreadByKey(threadKey);
    }

    if (this.options.threadControlService) {
      await this.options.threadControlService.resetThreadSession(threadKey);
    }

    this.logger.info({
      event: 'telegram_topic_deleted_via_command',
      chat_id: route.chatId,
      message_thread_id: messageThreadId,
      thread_key: threadKey,
      cleared_task_count: clearedTaskCount,
      command: 'delete',
    });
  }

  private logTaskTopicCreateFailure(taskId: string, chatId: number, error: Error): Error {
    this.logger.warn({
      event: 'telegram_task_topic_create_failed',
      task_id: taskId,
      chat_id: chatId,
      error_message: error.message,
    });

    return error;
  }

  private async reply(ctx: Context, text: string): Promise<void> {
    await ctx.reply(text);
  }

  private async handleUnauthorizedTelegramAccess(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const allowCommand = buildTelegramAllowCommand(userId, this.workspaceDir);

    this.logger.warn({
      event: 'telegram_unauthorized_access',
      chat_id: ctx.chat?.id ?? null,
      user_id: userId ?? null,
      username: ctx.from?.username ?? null,
      first_name: ctx.from?.first_name ?? null,
      last_name: ctx.from?.last_name ?? null,
      suggested_allow_command: allowCommand,
    });

    if (!allowCommand) {
      await this.reply(ctx, '🔒 This bot is private. Ask the operator to allow your Telegram user id.');
      return;
    }

    await this.reply(
      ctx,
      [
        '🔒 This bot is private. You are not authorized yet.',
        'Operator: run this exact command on the host to allow this user:',
        allowCommand,
        'Then send /start again.',
      ].join('\n'),
    );
  }

  private async handleAssistantMessage(ctx: Context, text: string, deliveryMode: 'steer' | 'followUp'): Promise<void> {
    await this.messageFlow.handleAssistantMessage(ctx, text, deliveryMode);
  }

  private startBackgroundRunDelivery(options: { runId: string; route: TelegramRoute; threadKey: string }): void {
    this.backgroundRuns.register(options.runId, options.threadKey, (signal) =>
      this.runDelivery.deliverRun(options.runId, options.route, signal),
    );
  }

  private abortBackgroundRunsForThread(threadKey: string): void {
    this.backgroundRuns.abortThread(threadKey);
  }
}

export { parseTelegramCommand };
