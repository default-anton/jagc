import { setTimeout as sleep } from 'node:timers/promises';

import type { Bot } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { Logger } from '../shared/logger.js';
import type { RunProgressEvent } from '../shared/run-progress.js';
import type { TelegramRoute } from '../shared/telegram-threading.js';
import { extractTelegramRetryAfterSeconds, isTelegramMessageNotModifiedError } from './telegram-api-errors.js';
import { renderTelegramText, type TelegramRenderedMessage } from './telegram-markdown.js';
import {
  callTelegramWithRetry,
  deleteProgressMessage,
  editProgressMessage,
  sendProgressChatAction,
  sendProgressMessage,
} from './telegram-progress-api.js';
import {
  isDeleteMessageGoneError,
  isEditMessageGoneError,
  pickProgressStartupLine,
  truncateMessage,
} from './telegram-progress-helpers.js';
import { TelegramProgressLog } from './telegram-progress-log.js';

type ProgressPhase = 'queued' | 'running' | 'succeeded' | 'failed';

interface TelegramRunProgressReporterOptions {
  bot: Bot;
  route: TelegramRoute;
  runId: string;
  logger: Logger;
  messageLimit?: number;
  minEditIntervalMs?: number;
  typingIntervalMs?: number;
}

export class TelegramRunProgressReporter {
  private readonly messageLimit: number;
  private readonly minEditIntervalMs: number;
  private readonly typingIntervalMs: number;
  private readonly startupLine = pickProgressStartupLine();
  private readonly progressLog = new TelegramProgressLog();
  private phase: ProgressPhase = 'queued';
  private terminalErrorMessage: string | null = null;

  private progressMessageId: number | null = null;
  private lastRenderedText = '';
  private lastRenderedEntitiesJson = '[]';
  private lastEditAt = 0;
  private nextEditAllowedAt = 0;
  private nextTypingAllowedAt = 0;
  private renderTimer: NodeJS.Timeout | null = null;
  private renderInFlight = false;
  private pendingRender = false;
  private typingTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: TelegramRunProgressReporterOptions) {
    this.messageLimit = options.messageLimit ?? 3500;
    this.minEditIntervalMs = options.minEditIntervalMs ?? 1500;
    this.typingIntervalMs = options.typingIntervalMs ?? 4000;
    this.progressLog.setMessageLimitHint(this.messageLimit);
  }

  async start(): Promise<void> {
    if (this.stopped || this.progressMessageId !== null) {
      return;
    }

    const initialRender = this.renderProgressMessage();

    try {
      const message = await callTelegramWithRetry(() =>
        sendProgressMessage(this.options.bot, this.options.route, initialRender.text, initialRender.entities),
      );
      this.progressMessageId = message.message_id;
      this.lastRenderedText = initialRender.text;
      this.lastRenderedEntitiesJson = JSON.stringify(initialRender.entities);
      this.lastEditAt = Date.now();
    } catch (error) {
      this.options.logger.warn({
        event: 'telegram_progress_start_failed',
        run_id: this.options.runId,
        chat_id: this.options.route.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.startTypingHeartbeat();
  }

  onProgress(event: RunProgressEvent): void {
    if (this.stopped || event.runId !== this.options.runId) {
      return;
    }

    let immediateRender = false;

    if (event.type !== 'assistant_thinking_delta') {
      immediateRender = this.progressLog.closeThinkingSegmentIfNeeded() || immediateRender;
    }

    switch (event.type) {
      case 'queued': {
        this.phase = 'queued';
        break;
      }
      case 'started':
      case 'delivered':
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'assistant_text_delta':
      case 'tool_execution_update': {
        this.phase = 'running';
        break;
      }
      case 'assistant_thinking_delta': {
        this.phase = 'running';
        immediateRender = this.progressLog.onThinkingDelta(event.delta, event.contentIndex) || immediateRender;
        break;
      }
      case 'tool_execution_start': {
        this.phase = 'running';
        immediateRender =
          this.progressLog.onToolExecutionStart(event.toolCallId, event.toolName, event.args) || immediateRender;
        break;
      }
      case 'tool_execution_end': {
        this.phase = 'running';
        immediateRender =
          this.progressLog.onToolExecutionEnd(event.toolCallId, event.toolName, event.isError) || immediateRender;
        break;
      }
      case 'succeeded': {
        this.phase = 'succeeded';
        immediateRender = true;
        this.progressLog.clearToolProgress();
        this.terminalErrorMessage = null;
        break;
      }
      case 'failed': {
        this.phase = 'failed';
        immediateRender = true;
        this.progressLog.clearToolProgress();
        this.terminalErrorMessage = event.errorMessage;
        break;
      }
      case 'agent_end': {
        if (this.phase !== 'succeeded' && this.phase !== 'failed') {
          this.phase = 'running';
        }

        this.progressLog.clearToolProgress();
        break;
      }
    }

    this.scheduleRender(immediateRender);
  }

  async finishSucceeded(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'succeeded';
    this.progressLog.clearToolProgress();
    await this.finish();
  }

  async finishFailed(errorMessage: string | null): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'failed';
    this.progressLog.clearToolProgress();
    this.terminalErrorMessage = errorMessage;
    await this.finish();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.clearRenderTimer();
    this.stopTypingHeartbeat();
  }

  private async finish(): Promise<void> {
    this.stopTypingHeartbeat();

    if (this.shouldDeleteStartupOnlyProgressMessage()) {
      await this.deleteProgressMessage();
      this.pendingRender = false;
      this.stopped = true;
      this.clearRenderTimer();
      return;
    }

    this.scheduleRender(true);
    await this.flushRenderIfIdle();

    if (this.pendingRender && this.progressLog.hasPendingArchiveLines()) {
      const waitMs = Math.max(0, this.nextEditAllowedAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      await this.flushRenderIfIdle();
    }

    this.stopped = true;
    this.clearRenderTimer();
  }

  private shouldDeleteStartupOnlyProgressMessage(): boolean {
    return this.progressMessageId !== null && this.progressLog.shouldDeleteStartupOnlyProgressMessage(this.phase);
  }

  private async deleteProgressMessage(): Promise<void> {
    const messageId = this.progressMessageId;
    if (messageId === null) {
      return;
    }

    try {
      await callTelegramWithRetry(() => deleteProgressMessage(this.options.bot, this.options.route, messageId));
    } catch (error) {
      if (!isDeleteMessageGoneError(error)) {
        this.options.logger.warn({
          event: 'telegram_progress_delete_failed',
          run_id: this.options.runId,
          chat_id: this.options.route.chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.progressMessageId === messageId) {
        this.progressMessageId = null;
      }

      this.lastRenderedText = '';
      this.lastRenderedEntitiesJson = '[]';
    }
  }

  private scheduleRender(immediate = false): void {
    if (this.stopped) {
      return;
    }

    this.pendingRender = true;

    if (this.renderInFlight || this.renderTimer) {
      return;
    }

    const now = Date.now();
    const waitForRateLimitMs = Math.max(0, this.nextEditAllowedAt - now);
    const waitForEditIntervalMs = Math.max(0, this.minEditIntervalMs - (now - this.lastEditAt));
    const delayMs = immediate ? waitForRateLimitMs : Math.max(waitForRateLimitMs, waitForEditIntervalMs);

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.flushRender();
    }, delayMs);
  }

  private async flushRenderIfIdle(): Promise<void> {
    await this.waitForRenderIdle();
    await this.flushRender();
  }

  private async waitForRenderIdle(): Promise<void> {
    while (this.renderInFlight) {
      await sleep(5);
    }
  }

  private async flushRender(): Promise<void> {
    if (this.stopped && this.phase !== 'succeeded' && this.phase !== 'failed') {
      return;
    }

    if (this.renderInFlight || !this.pendingRender || this.progressMessageId === null) {
      return;
    }

    this.renderInFlight = true;
    this.pendingRender = false;

    let rendered: TelegramRenderedMessage = {
      text: this.lastRenderedText,
      entities: [],
    };
    let entitiesJson = this.lastRenderedEntitiesJson;

    try {
      this.progressLog.archiveOverflowEventLogLines(
        () =>
          this.progressLog
            .buildProgressLines({
              phase: this.phase,
              startupLine: this.startupLine,
              terminalErrorMessage: this.terminalErrorMessage,
            })
            .join('\n').length,
      );
      await this.progressLog.flushPendingArchiveLines({
        force: this.phase === 'succeeded' || this.phase === 'failed',
        messageLimit: this.messageLimit,
        sendChunk: async (text) => {
          await callTelegramWithRetry(() => sendProgressMessage(this.options.bot, this.options.route, text, []));
        },
      });

      rendered = this.renderProgressMessage();
      entitiesJson = JSON.stringify(rendered.entities);
      if (rendered.text === this.lastRenderedText && entitiesJson === this.lastRenderedEntitiesJson) {
        return;
      }

      await editProgressMessage(
        this.options.bot,
        this.options.route,
        this.progressMessageId,
        rendered.text,
        rendered.entities,
      );
      this.lastRenderedText = rendered.text;
      this.lastRenderedEntitiesJson = entitiesJson;
      this.lastEditAt = Date.now();
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        this.lastRenderedText = rendered.text;
        this.lastRenderedEntitiesJson = entitiesJson;
        this.lastEditAt = Date.now();
      } else {
        const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
        if (retryAfterSeconds !== null) {
          this.nextEditAllowedAt = Date.now() + Math.ceil(retryAfterSeconds * 1000);
          this.pendingRender = true;
        } else if (isEditMessageGoneError(error)) {
          await this.recreateProgressMessage(rendered, entitiesJson);
        } else {
          this.options.logger.warn({
            event: 'telegram_progress_edit_failed',
            run_id: this.options.runId,
            chat_id: this.options.route.chatId,
            message: error instanceof Error ? error.message : String(error),
          });

          if (this.progressLog.hasPendingArchiveLines()) {
            this.pendingRender = true;
          }
        }
      }
    } finally {
      this.renderInFlight = false;
      if (this.pendingRender && !this.stopped) {
        this.scheduleRender();
      }
    }
  }

  private async recreateProgressMessage(rendered: TelegramRenderedMessage, entitiesJson: string): Promise<void> {
    try {
      const message = await callTelegramWithRetry(() =>
        sendProgressMessage(this.options.bot, this.options.route, rendered.text, rendered.entities),
      );
      this.progressMessageId = message.message_id;
      this.lastRenderedText = rendered.text;
      this.lastRenderedEntitiesJson = entitiesJson;
      this.lastEditAt = Date.now();
    } catch (error) {
      this.options.logger.warn({
        event: 'telegram_progress_recreate_failed',
        run_id: this.options.runId,
        chat_id: this.options.route.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startTypingHeartbeat(): void {
    if (this.typingTimer) {
      return;
    }

    void this.sendTypingAction();
    this.typingTimer = setInterval(() => {
      void this.sendTypingAction();
    }, this.typingIntervalMs);
  }

  private stopTypingHeartbeat(): void {
    if (!this.typingTimer) {
      return;
    }

    clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  private async sendTypingAction(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (Date.now() < this.nextTypingAllowedAt) {
      return;
    }

    try {
      await sendProgressChatAction(this.options.bot, this.options.route, 'typing');
    } catch (error) {
      const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
      if (retryAfterSeconds !== null) {
        this.nextTypingAllowedAt = Date.now() + Math.ceil(retryAfterSeconds * 1000);
        return;
      }

      this.options.logger.warn({
        event: 'telegram_typing_indicator_failed',
        run_id: this.options.runId,
        chat_id: this.options.route.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private renderProgressMessage(): TelegramRenderedMessage {
    const sourceLines = truncateMessage(
      this.progressLog
        .buildProgressLines({
          phase: this.phase,
          startupLine: this.startupLine,
          terminalErrorMessage: this.terminalErrorMessage,
        })
        .join('\n'),
      this.messageLimit,
    ).split('\n');
    const renderedLines: string[] = [];
    const entities: MessageEntity[] = [];

    let offset = 0;
    for (let index = 0; index < sourceLines.length; index += 1) {
      const sourceLine = sourceLines[index] ?? '';
      const renderedLine = this.renderProgressLine(sourceLine);
      renderedLines.push(renderedLine.text);

      for (const entity of renderedLine.entities) {
        entities.push({
          ...entity,
          offset: entity.offset + offset,
        });
      }

      offset += renderedLine.text.length;
      if (index < sourceLines.length - 1) {
        offset += 1;
      }
    }

    return {
      text: renderedLines.join('\n'),
      entities,
    };
  }

  private renderProgressLine(line: string): TelegramRenderedMessage {
    if (!line.startsWith('~ ')) {
      return {
        text: line,
        entities: [],
      };
    }

    const renderedThinking = renderTelegramText(line.slice(2));
    return {
      text: `~ ${renderedThinking.text}`,
      entities: renderedThinking.entities.map((entity) => ({
        ...entity,
        offset: entity.offset + 2,
      })),
    };
  }

  private clearRenderTimer(): void {
    if (!this.renderTimer) {
      return;
    }

    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }
}
