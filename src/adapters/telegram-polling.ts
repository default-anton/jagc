import { homedir } from 'node:os';
import { join } from 'node:path';

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
import { type TelegramRoute, telegramThreadKeyFromRoute } from '../shared/telegram-threading.js';
import { TelegramBackgroundRunRegistry } from './telegram-background-run-registry.js';
import { parseTelegramCallbackData } from './telegram-controls-callbacks.js';
import {
  callTelegramWithRetry,
  canonicalizeTelegramUserId,
  formatShellArgument,
  formatTaskTopicTitle,
  helpText,
  type ParsedTelegramCommand,
  parseTelegramCommand,
  routeFromCallbackContext,
  routeFromMessageContext,
  telegramUserKey,
  userFacingError,
} from './telegram-polling-helpers.js';
import { TelegramRunDelivery } from './telegram-run-delivery.js';
import { TelegramRuntimeControls } from './telegram-runtime-controls.js';

const defaultPollIntervalMs = 500;
const defaultPollRequestTimeoutSeconds = 30;
const telegramMessageLimit = 3500;
const defaultWorkspaceDir = join(homedir(), '.jagc');

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
  private readonly backgroundRuns = new TelegramBackgroundRunRegistry();

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
    this.runDelivery = new TelegramRunDelivery({
      bot: this.bot,
      runService: options.runService,
      logger: this.logger,
      pollIntervalMs: this.pollIntervalMs,
      messageLimit: telegramMessageLimit,
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

    this.bot.on('callback_query:data', async (ctx) => {
      await this.handleCallbackQuery(ctx);
    });
  }

  async start(): Promise<void> {
    if (this.runner) {
      return;
    }

    await this.bot.init();
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
    this.logger.info({ event: 'telegram_polling_started', username });
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
    await this.ensureReadyForOutbound();

    const created = (await callTelegramWithRetry(() =>
      this.bot.api.raw.createForumTopic({
        chat_id: input.chatId,
        name: formatTaskTopicTitle(input.taskId, input.title),
      }),
    )) as { message_thread_id?: number };

    const messageThreadId = Number(created.message_thread_id);
    if (!Number.isInteger(messageThreadId) || messageThreadId <= 0) {
      throw new Error('telegram_topics_unavailable: createForumTopic did not return message_thread_id');
    }

    return {
      chatId: input.chatId,
      messageThreadId,
    };
  }

  async syncTaskTopicTitle(route: TelegramRoute, taskId: string, title: string): Promise<void> {
    const messageThreadId = route.messageThreadId;
    if (!messageThreadId) {
      throw new Error('cannot sync Telegram topic title without message_thread_id');
    }

    await this.ensureReadyForOutbound();

    await callTelegramWithRetry(() =>
      this.bot.api.raw.editForumTopic({
        chat_id: route.chatId,
        message_thread_id: messageThreadId,
        name: formatTaskTopicTitle(taskId, title),
      }),
    );
  }

  async deliverRun(runId: string, route: TelegramRoute): Promise<void> {
    this.startBackgroundRunDelivery({
      runId,
      route,
      threadKey: telegramThreadKeyFromRoute(route),
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

    if (!this.isTelegramUserAuthorized(ctx.from?.id)) {
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

  private async handleCommand(ctx: Context, command: ParsedTelegramCommand, rawText: string): Promise<void> {
    try {
      switch (command.command) {
        case 'start':
        case 'help': {
          await this.reply(ctx, helpText());
          return;
        }
        case 'settings': {
          await this.runtimeControls.handleSettingsCommand(ctx);
          return;
        }
        case 'cancel': {
          const cancelled = await this.runtimeControls.handleCancelCommand(ctx);
          if (cancelled && ctx.chat) {
            const route = routeFromMessageContext(ctx);
            this.abortBackgroundRunsForThread(telegramThreadKeyFromRoute(route));
          }
          return;
        }
        case 'new': {
          await this.runtimeControls.handleNewCommand(ctx);
          return;
        }
        case 'share': {
          await this.runtimeControls.handleShareCommand(ctx);
          return;
        }
        case 'model': {
          await this.runtimeControls.handleModelCommand(ctx, command.args);
          return;
        }
        case 'thinking': {
          await this.runtimeControls.handleThinkingCommand(ctx, command.args);
          return;
        }
        case 'auth': {
          await this.runtimeControls.handleAuthCommand(ctx, command.args);
          return;
        }
        case 'steer': {
          await this.handleAssistantMessage(ctx, command.args.trim(), 'steer');
          return;
        }
        default: {
          await this.handleAssistantMessage(ctx, rawText, 'followUp');
          return;
        }
      }
    } catch (error) {
      const message = userFacingError(error);
      this.logger.error({
        event: 'telegram_command_failed',
        chat_id: ctx.chat?.id,
        thread_key: ctx.chat ? telegramThreadKeyFromRoute(routeFromMessageContext(ctx)) : null,
        command: command.command,
        message,
      });
      await this.reply(ctx, `❌ ${message}`);
    }
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await ctx.answerCallbackQuery({ text: 'This action is supported in personal chats only.' });
      return;
    }

    if (!this.isTelegramUserAuthorized(ctx.from?.id)) {
      await this.handleUnauthorizedTelegramAccess(ctx);
      try {
        await ctx.answerCallbackQuery({ text: 'Not authorized yet. Ask operator to allow your user id.' });
      } catch {
        // no-op: fallback chat reply from handleUnauthorizedTelegramAccess is sufficient
      }
      return;
    }

    const data = ctx.callbackQuery?.data;
    if (!data) {
      await ctx.answerCallbackQuery();
      return;
    }

    const callbackRoute = routeFromCallbackContext(ctx);

    const action = parseTelegramCallbackData(data);
    if (!action) {
      try {
        await ctx.answerCallbackQuery({ text: 'This menu is outdated. Loading latest settings...' });
      } catch (error) {
        this.logger.warn({
          event: 'telegram_callback_query_ack_failed',
          chat_id: ctx.chat.id,
          thread_key: telegramThreadKeyFromRoute(callbackRoute),
          callback_data: data,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await this.runtimeControls.handleStaleCallback(ctx);
      } catch (error) {
        const message = userFacingError(error);
        this.logger.error({
          event: 'telegram_callback_query_stale_recovery_failed',
          chat_id: ctx.chat.id,
          thread_key: telegramThreadKeyFromRoute(callbackRoute),
          callback_data: data,
          message,
        });

        await this.reply(ctx, 'This menu is outdated. Use /settings to refresh.');
      }

      return;
    }

    const callbackLogContext = {
      chat_id: ctx.chat.id,
      thread_key: telegramThreadKeyFromRoute(callbackRoute),
      callback_data: data,
      action_kind: action.kind,
    };

    try {
      await ctx.answerCallbackQuery();
    } catch (error) {
      this.logger.warn({
        event: 'telegram_callback_query_ack_failed',
        ...callbackLogContext,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.runtimeControls.handleCallbackAction(ctx, action);
      this.logger.info({ event: 'telegram_callback_query_handled', ...callbackLogContext });
    } catch (error) {
      const message = userFacingError(error);

      this.logger.error({
        event: 'telegram_callback_query_failed',
        ...callbackLogContext,
        message,
      });

      await this.reply(ctx, `❌ ${message}`);
    }
  }

  private async reply(ctx: Context, text: string): Promise<void> {
    await ctx.reply(text);
  }

  private isTelegramUserAuthorized(userId: number | undefined): boolean {
    if (userId === undefined) {
      return false;
    }

    return this.allowedTelegramUserIds.has(String(userId));
  }

  private async handleUnauthorizedTelegramAccess(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const allowCommand = this.buildTelegramAllowCommand(userId);

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

  private buildTelegramAllowCommand(userId: number | undefined): string | null {
    if (userId === undefined) {
      return null;
    }

    const commandParts = ['jagc', 'telegram', 'allow', '--user-id', String(userId)];
    if (this.workspaceDir && this.workspaceDir !== defaultWorkspaceDir) {
      commandParts.push('--workspace-dir', this.workspaceDir);
    }

    return commandParts.map((part) => formatShellArgument(part)).join(' ');
  }

  private async handleAssistantMessage(ctx: Context, text: string, deliveryMode: 'steer' | 'followUp'): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      await this.reply(ctx, 'Message is empty.');
      return;
    }

    const route = routeFromMessageContext(ctx);
    const threadKey = telegramThreadKeyFromRoute(route);
    const userKey = telegramUserKey(ctx.from?.id);

    const ingested = await this.options.runService.ingestMessage({
      source: 'telegram',
      threadKey,
      userKey,
      text: prompt,
      deliveryMode,
      idempotencyKey: `telegram:update:${ctx.update.update_id}`,
    });

    await this.deliverRun(ingested.run.runId, route);
  }

  private startBackgroundRunDelivery(options: { runId: string; route: TelegramRoute; threadKey: string }): void {
    this.backgroundRuns.register(options.runId, options.threadKey, (signal) =>
      this.runDelivery.deliverRun(options.runId, options.route, signal),
    );
  }

  private abortBackgroundRunsForThread(threadKey: string): void {
    this.backgroundRuns.abortThread(threadKey);
  }

  private async ensureReadyForOutbound(): Promise<void> {
    if (!this.runner) {
      await this.start();
    }
  }
}

export { parseTelegramCommand };
