import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { type RunnerHandle, run } from '@grammyjs/runner';
import { Bot, type BotConfig, type Context, InputFile } from 'grammy';
import type { MessageEntity } from 'grammy/types';
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
import type { RunProgressEvent } from '../shared/run-progress.js';
import type { RunRecord } from '../shared/run-types.js';
import { extractTelegramRetryAfterSeconds } from './telegram-api-errors.js';
import { parseTelegramCallbackData } from './telegram-controls-callbacks.js';
import { renderTelegramMarkdown, type TelegramRenderedAttachment } from './telegram-markdown.js';
import { TelegramRunProgressReporter } from './telegram-progress.js';
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

interface ParsedTelegramCommand {
  command: string;
  args: string;
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
  private readonly backgroundRunTasks = new Set<Promise<void>>();
  private readonly backgroundRunAbortControllers = new Set<AbortController>();
  private readonly backgroundRunAbortControllersByThread = new Map<string, Set<AbortController>>();

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
    for (const controller of this.backgroundRunAbortControllers) {
      controller.abort();
    }

    if (this.backgroundRunTasks.size > 0) {
      await Promise.allSettled([...this.backgroundRunTasks]);
    }

    this.backgroundRunAbortControllers.clear();
    this.backgroundRunAbortControllersByThread.clear();

    if (!this.runner) {
      return;
    }

    await this.runner.stop();
    this.runner = null;
    this.logger.info({ event: 'telegram_polling_stopped' });
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
            this.abortBackgroundRunsForThread(telegramThreadKey(ctx.chat.id));
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
        thread_key: ctx.chat ? telegramThreadKey(ctx.chat.id) : null,
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

    const action = parseTelegramCallbackData(data);
    if (!action) {
      try {
        await ctx.answerCallbackQuery({ text: 'This menu is outdated. Loading latest settings...' });
      } catch (error) {
        this.logger.warn({
          event: 'telegram_callback_query_ack_failed',
          chat_id: ctx.chat.id,
          thread_key: telegramThreadKey(ctx.chat.id),
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
          thread_key: telegramThreadKey(ctx.chat.id),
          callback_data: data,
          message,
        });

        await this.reply(ctx, 'This menu is outdated. Use /settings to refresh.');
      }

      return;
    }

    const callbackLogContext = {
      chat_id: ctx.chat.id,
      thread_key: telegramThreadKey(ctx.chat.id),
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

    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      throw new Error('telegram message has no chat id');
    }

    const threadKey = telegramThreadKey(chatId);
    const userKey = telegramUserKey(ctx.from?.id);

    const ingested = await this.options.runService.ingestMessage({
      source: 'telegram',
      threadKey,
      userKey,
      text: prompt,
      deliveryMode,
      idempotencyKey: `telegram:update:${ctx.update.update_id}`,
    });

    if (ingested.run.status !== 'running') {
      await this.replyRunResult(chatId, formatRunResult(ingested.run));
      return;
    }

    const backgroundAbortController = new AbortController();
    this.trackBackgroundRunAbortController(threadKey, backgroundAbortController);

    const progressReporter = new TelegramRunProgressReporter({
      bot: this.bot,
      chatId,
      runId: ingested.run.runId,
      logger: this.logger,
      messageLimit: telegramMessageLimit,
    });

    try {
      await progressReporter.start();
    } catch (error) {
      this.untrackBackgroundRunAbortController(threadKey, backgroundAbortController);
      throw error;
    }

    const unsubscribe = this.subscribeRunProgress(ingested.run.runId, (event) => {
      progressReporter.onProgress(event);
    });

    let backgroundTask: Promise<void> | null = null;
    backgroundTask = this.continueRunInBackground({
      chatId,
      runId: ingested.run.runId,
      progressReporter,
      unsubscribe,
      signal: backgroundAbortController.signal,
    }).finally(() => {
      if (backgroundTask) {
        this.backgroundRunTasks.delete(backgroundTask);
      }
      this.untrackBackgroundRunAbortController(threadKey, backgroundAbortController);
    });

    this.backgroundRunTasks.add(backgroundTask);
  }

  private async continueRunInBackground(options: {
    chatId: number;
    runId: string;
    progressReporter: TelegramRunProgressReporter;
    unsubscribe: () => void;
    signal: AbortSignal;
  }): Promise<void> {
    try {
      const completedRun = await this.waitForCompletion(options.runId, options.signal);
      if (options.signal.aborted) {
        throw new Error('telegram run wait aborted');
      }

      if (completedRun.status === 'failed') {
        await options.progressReporter.finishFailed(completedRun.errorMessage);
      } else {
        await options.progressReporter.finishSucceeded();
      }

      await this.replyRunResult(options.chatId, formatRunResult(completedRun));
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      const message = userFacingError(error);
      this.logger.error({
        event: 'telegram_background_run_wait_failed',
        run_id: options.runId,
        chat_id: options.chatId,
        message,
      });

      await options.progressReporter.finishFailed(message);
      await this.sendMessage(options.chatId, `❌ ${message}`);
    } finally {
      options.unsubscribe();
      await options.progressReporter.dispose();
    }
  }

  private async waitForCompletion(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    while (true) {
      if (signal?.aborted) {
        throw new Error('telegram run wait aborted');
      }

      const run = await this.options.runService.getRun(runId);
      if (!run) {
        throw new Error(`run ${runId} not found while waiting for completion`);
      }

      if (signal?.aborted) {
        throw new Error('telegram run wait aborted');
      }

      if (run.status !== 'running') {
        return run;
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private subscribeRunProgress(runId: string, listener: (event: RunProgressEvent) => void): () => void {
    const runService = this.options.runService as RunService & {
      subscribeRunProgress?: (runId: string, listener: (event: RunProgressEvent) => void) => () => void;
    };

    if (typeof runService.subscribeRunProgress !== 'function') {
      return () => {};
    }

    return runService.subscribeRunProgress(runId, listener);
  }

  private trackBackgroundRunAbortController(threadKey: string, controller: AbortController): void {
    this.backgroundRunAbortControllers.add(controller);

    const threadControllers = this.backgroundRunAbortControllersByThread.get(threadKey) ?? new Set<AbortController>();
    threadControllers.add(controller);
    this.backgroundRunAbortControllersByThread.set(threadKey, threadControllers);
  }

  private untrackBackgroundRunAbortController(threadKey: string, controller: AbortController): void {
    this.backgroundRunAbortControllers.delete(controller);

    const threadControllers = this.backgroundRunAbortControllersByThread.get(threadKey);
    if (!threadControllers) {
      return;
    }

    threadControllers.delete(controller);
    if (threadControllers.size === 0) {
      this.backgroundRunAbortControllersByThread.delete(threadKey);
    }
  }

  private abortBackgroundRunsForThread(threadKey: string): void {
    const threadControllers = this.backgroundRunAbortControllersByThread.get(threadKey);
    if (!threadControllers) {
      return;
    }

    for (const controller of threadControllers) {
      controller.abort();
    }
  }

  private async replyRunResult(chatId: number, runResult: FormattedRunResult): Promise<void> {
    if (runResult.mode === 'plain') {
      await this.replyLong(chatId, runResult.text);
      return;
    }

    const rendered = renderTelegramMarkdown(runResult.text, {
      messageLimit: telegramMessageLimit,
    });

    for (const message of rendered.messages) {
      await this.sendMarkdownMessage(chatId, message.text, message.entities);
    }

    for (const attachment of rendered.attachments) {
      await this.sendCodeAttachment(chatId, attachment);
    }
  }

  private async replyLong(chatId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, telegramMessageLimit)) {
      await this.sendMessage(chatId, chunk);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await callTelegramWithRetry(() => this.bot.api.sendMessage(chatId, text));
  }

  private async sendMarkdownMessage(chatId: number, text: string, entities: MessageEntity[]): Promise<void> {
    await callTelegramWithRetry(() => this.bot.api.sendMessage(chatId, text, { entities }));
  }

  private async sendCodeAttachment(chatId: number, attachment: TelegramRenderedAttachment): Promise<void> {
    const inputFile = new InputFile(Buffer.from(attachment.content, 'utf8'), attachment.filename);
    await callTelegramWithRetry(() =>
      this.bot.api.sendDocument(chatId, inputFile, {
        caption: attachment.caption,
      }),
    );
  }
}

async function callTelegramWithRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
      if (retryAfterSeconds === null || attempt >= maxAttempts - 1) {
        throw error;
      }

      attempt += 1;
      await sleep(Math.ceil(retryAfterSeconds * 1000));
    }
  }
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  return {
    command: match[1]?.toLowerCase() ?? '',
    args: match[2] ?? '',
  };
}

type FormattedRunResult =
  | {
      mode: 'plain';
      text: string;
    }
  | {
      mode: 'markdown';
      text: string;
    };

function formatRunResult(run: RunRecord): FormattedRunResult {
  if (run.status === 'failed') {
    return {
      mode: 'plain',
      text: `❌ ${run.errorMessage ?? 'run failed'}`,
    };
  }

  if (!run.output) {
    return {
      mode: 'plain',
      text: 'Run succeeded with no output.',
    };
  }

  const messageText = run.output.text;
  if (typeof messageText === 'string' && messageText.trim().length > 0) {
    return {
      mode: 'markdown',
      text: messageText,
    };
  }

  return {
    mode: 'plain',
    text: `Run output:\n${JSON.stringify(run.output, null, 2)}`,
  };
}

function helpText(): string {
  return [
    'jagc Telegram commands:',
    '/settings — open runtime settings',
    '/cancel — stop the active run in this chat (session stays intact)',
    '/new — reset this chat session (next message starts fresh)',
    '/share — export this chat session and upload a secret gist',
    '/model — open model picker',
    '/thinking — open thinking picker',
    '/auth — open provider login controls',
    '/steer <message> — send an interrupting message (explicit steer)',
    'Any other /command is forwarded to the assistant as a normal message.',
  ].join('\n');
}

function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxLength) {
    const breakIndex = rest.lastIndexOf('\n', maxLength);
    const splitIndex = breakIndex > maxLength / 3 ? breakIndex : maxLength;

    chunks.push(rest.slice(0, splitIndex));
    rest = rest.slice(splitIndex).trimStart();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }

  return chunks;
}

function telegramThreadKey(chatId: number | undefined): string {
  if (chatId === undefined) {
    throw new Error('telegram message has no chat id');
  }

  return `telegram:chat:${chatId}`;
}

function telegramUserKey(userId: number | undefined): string | undefined {
  if (userId === undefined) {
    return undefined;
  }

  return `telegram:user:${userId}`;
}

function formatShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function canonicalizeTelegramUserId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`allowedTelegramUserIds contains invalid Telegram user id '${value}'.`);
  }

  return BigInt(trimmed).toString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === 'telegram run wait aborted';
}

function userFacingError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 180);
  }

  return 'Action failed. Please try again.';
}
