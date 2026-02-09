import { setTimeout as sleep } from 'node:timers/promises';

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
import type { RunProgressEvent } from '../shared/run-progress.js';
import type { RunRecord } from '../shared/run-types.js';
import { extractTelegramRetryAfterSeconds } from './telegram-api-errors.js';
import { parseTelegramCallbackData } from './telegram-controls-callbacks.js';
import { TelegramRunProgressReporter } from './telegram-progress.js';
import { TelegramRuntimeControls } from './telegram-runtime-controls.js';

const defaultWaitTimeoutMs = 180_000;
const defaultPollIntervalMs = 500;
const defaultPollRequestTimeoutSeconds = 30;
const telegramMessageLimit = 3500;

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
  waitTimeoutMs?: number;
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
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollRequestTimeoutSeconds: number;
  private readonly logger: Logger;
  private readonly backgroundRunTasks = new Set<Promise<void>>();
  private readonly backgroundRunAbortControllers = new Set<AbortController>();

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
    this.waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.pollRequestTimeoutSeconds = options.pollRequestTimeoutSeconds ?? defaultPollRequestTimeoutSeconds;
    this.logger = options.logger ?? noopLogger;

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

    if (!this.runner) {
      return;
    }

    await this.runner.stop();
    this.runner = null;
    this.logger.info({ event: 'telegram_polling_stopped' });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await ctx.reply('Telegram adapter currently supports personal chats only.');
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }

    const command = parseTelegramCommand(text);
    if (command) {
      await this.handleCommand(ctx, command);
      return;
    }

    await this.handleAssistantMessage(ctx, text, 'followUp');
  }

  private async handleCommand(ctx: Context, command: ParsedTelegramCommand): Promise<void> {
    try {
      switch (command.command) {
        case 'start':
        case 'help': {
          await ctx.reply(helpText());
          return;
        }
        case 'settings': {
          await this.runtimeControls.handleSettingsCommand(ctx);
          return;
        }
        case 'new': {
          await this.runtimeControls.handleNewCommand(ctx);
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
          await ctx.reply(`Unknown command: /${command.command}`);
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
      await ctx.reply(`❌ ${message}`);
    }
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await ctx.answerCallbackQuery({ text: 'This action is supported in personal chats only.' });
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

        await ctx.reply('This menu is outdated. Use /settings to refresh.');
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

      await ctx.reply(`❌ ${message}`);
    }
  }

  private async handleAssistantMessage(ctx: Context, text: string, deliveryMode: 'steer' | 'followUp'): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      await ctx.reply('Message is empty.');
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
      await this.replyLong(chatId, formatRunResult(ingested.run));
      return;
    }

    const progressReporter = new TelegramRunProgressReporter({
      bot: this.bot,
      chatId,
      runId: ingested.run.runId,
      deliveryMode,
      logger: this.logger,
      messageLimit: telegramMessageLimit,
    });

    await progressReporter.start();

    const unsubscribe = this.subscribeRunProgress(ingested.run.runId, (event) => {
      progressReporter.onProgress(event);
    });

    let backgroundContinuationStarted = false;

    try {
      const completedRun = await this.waitForCompletion(ingested.run.runId, this.waitTimeoutMs);
      if (completedRun.status === 'running') {
        await progressReporter.markLongRunning();
        await this.sendMessage(
          chatId,
          `Run queued as ${completedRun.runId}. Still running. I'll send the result when it's done.`,
        );

        backgroundContinuationStarted = true;

        const backgroundAbortController = new AbortController();
        this.backgroundRunAbortControllers.add(backgroundAbortController);

        let backgroundTask: Promise<void> | null = null;
        backgroundTask = this.continueRunInBackground({
          chatId,
          runId: completedRun.runId,
          progressReporter,
          unsubscribe,
          signal: backgroundAbortController.signal,
        }).finally(() => {
          if (backgroundTask) {
            this.backgroundRunTasks.delete(backgroundTask);
          }
          this.backgroundRunAbortControllers.delete(backgroundAbortController);
        });

        this.backgroundRunTasks.add(backgroundTask);
        return;
      }

      if (completedRun.status === 'failed') {
        await progressReporter.finishFailed(completedRun.errorMessage);
      } else {
        await progressReporter.finishSucceeded();
      }

      await this.replyLong(chatId, formatRunResult(completedRun));
    } finally {
      if (!backgroundContinuationStarted) {
        unsubscribe();
        await progressReporter.dispose();
      }
    }
  }

  private async continueRunInBackground(options: {
    chatId: number;
    runId: string;
    progressReporter: TelegramRunProgressReporter;
    unsubscribe: () => void;
    signal: AbortSignal;
  }): Promise<void> {
    try {
      const completedRun = await this.waitForCompletion(options.runId, null, options.signal);
      if (completedRun.status === 'running') {
        return;
      }

      if (completedRun.status === 'failed') {
        await options.progressReporter.finishFailed(completedRun.errorMessage);
      } else {
        await options.progressReporter.finishSucceeded();
      }

      await this.replyLong(options.chatId, formatRunResult(completedRun));
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

  private async waitForCompletion(runId: string, timeoutMs: number | null, signal?: AbortSignal): Promise<RunRecord> {
    const startedAt = Date.now();

    while (true) {
      if (signal?.aborted) {
        throw new Error('telegram run wait aborted');
      }

      const run = await this.options.runService.getRun(runId);
      if (!run) {
        throw new Error(`run ${runId} not found while waiting for completion`);
      }

      if (run.status !== 'running') {
        return run;
      }

      if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
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

  private async replyLong(chatId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, telegramMessageLimit)) {
      await this.sendMessage(chatId, chunk);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await callTelegramWithRetry(() => this.bot.api.sendMessage(chatId, text));
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

function formatRunResult(run: RunRecord): string {
  if (run.status === 'failed') {
    return `❌ ${run.errorMessage ?? 'run failed'}`;
  }

  if (!run.output) {
    return 'Run succeeded with no output.';
  }

  const messageText = run.output.text;
  if (typeof messageText === 'string' && messageText.trim().length > 0) {
    return messageText;
  }

  return `Run output:\n${JSON.stringify(run.output, null, 2)}`;
}

function helpText(): string {
  return [
    'jagc Telegram commands:',
    '/settings — open runtime settings',
    '/new — reset this chat session (next message starts fresh)',
    '/model — open model picker',
    '/thinking — open thinking picker',
    '/auth — open provider login controls',
    '/steer <message> — send an interrupting message (explicit steer)',
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === 'telegram run wait aborted';
}

function userFacingError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 180);
  }

  return 'Action failed. Please try again.';
}
