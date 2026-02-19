import { setTimeout as sleep } from 'node:timers/promises';

import { type Bot, InputFile } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { RunService } from '../server/service.js';
import type { Logger } from '../shared/logger.js';
import type { RunProgressEvent } from '../shared/run-progress.js';
import type { RunRecord } from '../shared/run-types.js';
import { normalizeTelegramMessageThreadId, type TelegramRoute } from '../shared/telegram-threading.js';
import { renderTelegramMarkdown, type TelegramRenderedAttachment } from './telegram-markdown.js';
import { TelegramRunProgressReporter } from './telegram-progress.js';
import { callTelegramWithRetry } from './telegram-retry.js';

const defaultPollIntervalMs = 500;
const defaultMessageLimit = 3500;

interface TelegramRunDeliveryOptions {
  bot: Bot;
  runService: RunService;
  logger: Logger;
  pollIntervalMs?: number;
  messageLimit?: number;
}

export class TelegramRunDelivery {
  private readonly pollIntervalMs: number;
  private readonly messageLimit: number;

  constructor(private readonly options: TelegramRunDeliveryOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.messageLimit = options.messageLimit ?? defaultMessageLimit;
  }

  async deliverRun(runId: string, route: TelegramRoute, signal?: AbortSignal): Promise<void> {
    this.options.logger.info({
      event: 'telegram_run_delivery_started',
      run_id: runId,
      chat_id: route.chatId,
      message_thread_id: route.messageThreadId,
    });

    const progressReporter = new TelegramRunProgressReporter({
      bot: this.options.bot,
      route,
      runId,
      logger: this.options.logger,
      messageLimit: this.messageLimit,
    });

    await progressReporter.start();

    const unsubscribe = this.subscribeRunProgress(runId, (event) => {
      progressReporter.onProgress(event);
    });

    try {
      const completedRun = await this.waitForCompletion(runId, signal);
      if (signal?.aborted) {
        throw new Error('telegram run wait aborted');
      }

      if (completedRun.status === 'failed') {
        await progressReporter.finishFailed(completedRun.errorMessage);
      } else {
        await progressReporter.finishSucceeded();
      }

      await this.replyRunResult(route, formatRunResult(completedRun));
      this.options.logger.info({
        event: 'telegram_run_delivery_completed',
        run_id: runId,
        chat_id: route.chatId,
        message_thread_id: route.messageThreadId,
        run_status: completedRun.status,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      const message = userFacingError(error);
      this.options.logger.error({
        event: 'telegram_background_run_wait_failed',
        run_id: runId,
        chat_id: route.chatId,
        message,
      });

      await progressReporter.finishFailed(message);
      await this.sendPlainMessage(route, `❌ ${message}`);
    } finally {
      unsubscribe();
      await progressReporter.dispose();
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

  private async replyRunResult(route: TelegramRoute, runResult: FormattedRunResult): Promise<void> {
    if (runResult.mode === 'plain') {
      await this.replyLong(route, runResult.text);
      return;
    }

    const rendered = renderTelegramMarkdown(runResult.text, {
      messageLimit: this.messageLimit,
    });

    for (const message of rendered.messages) {
      await this.sendMarkdownMessage(route, message.text, message.entities);
    }

    for (const attachment of rendered.attachments) {
      await this.sendCodeAttachment(route, attachment);
    }
  }

  private async replyLong(route: TelegramRoute, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, this.messageLimit)) {
      await this.sendPlainMessage(route, chunk);
    }
  }

  private async sendPlainMessage(route: TelegramRoute, text: string): Promise<void> {
    await callTelegramWithRetry(() => this.sendMessage(route, text));
  }

  private async sendMarkdownMessage(route: TelegramRoute, text: string, entities: MessageEntity[]): Promise<void> {
    await callTelegramWithRetry(() => this.sendMessage(route, text, entities));
  }

  private async sendCodeAttachment(route: TelegramRoute, attachment: TelegramRenderedAttachment): Promise<void> {
    const inputFile = new InputFile(Buffer.from(attachment.content, 'utf8'), attachment.filename);
    await callTelegramWithRetry(() => this.sendDocument(route, inputFile, attachment.caption));
  }

  private sendMessage(route: TelegramRoute, text: string, entities?: MessageEntity[]): Promise<unknown> {
    return this.options.bot.api.raw.sendMessage({
      ...routePayload(route),
      text,
      ...(entities && entities.length > 0 ? { entities } : {}),
    });
  }

  private sendDocument(route: TelegramRoute, document: InputFile, caption: string): Promise<unknown> {
    return this.options.bot.api.raw.sendDocument({
      ...routePayload(route),
      document,
      caption,
    });
  }
}

function routePayload(route: TelegramRoute): { chat_id: number; message_thread_id?: number } {
  const messageThreadId = normalizeTelegramMessageThreadId(route.messageThreadId);

  return {
    chat_id: route.chatId,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === 'telegram run wait aborted';
}

function userFacingError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 180);
  }

  return 'Action failed. Please try again.';
}
