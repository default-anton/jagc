import { setTimeout as sleep } from 'node:timers/promises';

import type { Bot } from 'grammy';
import type { Logger } from '../shared/logger.js';
import type { RunProgressEvent } from '../shared/run-progress.js';
import { extractTelegramRetryAfterSeconds, isTelegramMessageNotModifiedError } from './telegram-api-errors.js';
import {
  appendTail,
  isDeleteMessageGoneError,
  isEditMessageGoneError,
  maxProgressToolLabelChars,
  normalizePreviewDelta,
  pickProgressStartupLine,
  summarizeToolLabel,
  truncateLine,
  truncateMessage,
} from './telegram-progress-helpers.js';

type ProgressPhase = 'queued' | 'running' | 'succeeded' | 'failed';

interface TelegramRunProgressReporterOptions {
  bot: Bot;
  chatId: number;
  runId: string;
  logger: Logger;
  messageLimit?: number;
  minEditIntervalMs?: number;
  typingIntervalMs?: number;
}

interface CurrentToolState {
  toolCallId: string;
  label: string;
}

const defaultMessageLimit = 3500;
const defaultMinEditIntervalMs = 1500;
const defaultTypingIntervalMs = 4000;
const maxEventLogLines = 48;
const maxThinkingPreviewChars = 240;
const maxDeltaChars = 200;
const minThinkingLogIntervalMs = 1_800;

export class TelegramRunProgressReporter {
  private readonly messageLimit: number;
  private readonly minEditIntervalMs: number;
  private readonly typingIntervalMs: number;
  private readonly startupLine = pickProgressStartupLine();

  private phase: ProgressPhase = 'queued';
  private showStartupLine = true;
  private isLongRunning = false;
  private terminalErrorMessage: string | null = null;

  private lastThinkingLoggedAt = 0;
  private thinkingPreview = '';
  private hasPendingThinkingPreview = false;

  private currentTool: CurrentToolState | null = null;
  private readonly toolLabelsByCallId = new Map<string, string>();
  private eventLogLines: string[] = [];

  private progressMessageId: number | null = null;
  private lastRenderedText = '';
  private lastEditAt = 0;
  private nextEditAllowedAt = 0;
  private nextTypingAllowedAt = 0;

  private renderTimer: NodeJS.Timeout | null = null;
  private renderInFlight = false;
  private pendingRender = false;

  private typingTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: TelegramRunProgressReporterOptions) {
    this.messageLimit = options.messageLimit ?? defaultMessageLimit;
    this.minEditIntervalMs = options.minEditIntervalMs ?? defaultMinEditIntervalMs;
    this.typingIntervalMs = options.typingIntervalMs ?? defaultTypingIntervalMs;
  }

  async start(): Promise<void> {
    if (this.stopped || this.progressMessageId !== null) {
      return;
    }

    const initialText = this.renderProgressText();

    try {
      const message = await this.callWithRetry(() =>
        this.options.bot.api.sendMessage(this.options.chatId, initialText),
      );
      this.progressMessageId = message.message_id;
      this.lastRenderedText = initialText;
      this.lastEditAt = Date.now();
    } catch (error) {
      this.options.logger.warn({
        event: 'telegram_progress_start_failed',
        run_id: this.options.runId,
        chat_id: this.options.chatId,
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
      immediateRender = this.flushThinkingPreviewToLog() || immediateRender;
    }

    switch (event.type) {
      case 'queued': {
        this.phase = 'queued';
        break;
      }
      case 'started':
      case 'delivered':
      case 'agent_start':
      case 'turn_start': {
        this.phase = 'running';
        this.isLongRunning = false;
        break;
      }
      case 'turn_end': {
        this.phase = 'running';
        break;
      }
      case 'assistant_text_delta': {
        this.phase = 'running';
        break;
      }
      case 'assistant_thinking_delta': {
        this.phase = 'running';
        const now = Date.now();

        const delta = normalizePreviewDelta(event.delta);
        if (delta.trim().length > 0) {
          this.showStartupLine = false;
          this.thinkingPreview = appendTail(this.thinkingPreview, delta.slice(-maxDeltaChars), maxThinkingPreviewChars);
          this.hasPendingThinkingPreview = true;
          if (now - this.lastThinkingLoggedAt >= minThinkingLogIntervalMs) {
            immediateRender = this.flushThinkingPreviewToLog(now) || immediateRender;
          }
        }
        break;
      }
      case 'tool_execution_start': {
        this.phase = 'running';
        this.showStartupLine = false;
        const label = summarizeToolLabel(event.toolName, event.args);
        this.toolLabelsByCallId.set(event.toolCallId, label);
        this.currentTool = {
          toolCallId: event.toolCallId,
          label,
        };
        immediateRender = this.pushEventLogLine(`> ${label}`);
        break;
      }
      case 'tool_execution_update': {
        this.phase = 'running';
        break;
      }
      case 'tool_execution_end': {
        this.phase = 'running';
        this.showStartupLine = false;
        const label = this.toolLabelsByCallId.get(event.toolCallId) ?? summarizeToolLabel(event.toolName, undefined);
        this.toolLabelsByCallId.delete(event.toolCallId);

        if (event.isError) {
          immediateRender = this.pushEventLogLine(`> ${label} failed`) || immediateRender;
        } else {
          immediateRender = this.pushEventLogLine(`> ${label} done`) || immediateRender;
        }

        if (this.currentTool?.toolCallId === event.toolCallId) {
          this.currentTool = null;
        }
        break;
      }
      case 'succeeded': {
        this.phase = 'succeeded';
        immediateRender = true;
        this.isLongRunning = false;
        this.currentTool = null;
        this.toolLabelsByCallId.clear();
        this.terminalErrorMessage = null;
        break;
      }
      case 'failed': {
        this.phase = 'failed';
        immediateRender = true;
        this.isLongRunning = false;
        this.currentTool = null;
        this.toolLabelsByCallId.clear();
        this.terminalErrorMessage = event.errorMessage;
        break;
      }
      case 'agent_end': {
        if (this.phase !== 'succeeded' && this.phase !== 'failed') {
          this.phase = 'running';
        }
        this.currentTool = null;
        this.toolLabelsByCallId.clear();
        break;
      }
    }

    this.scheduleRender(immediateRender);
  }

  async markLongRunning(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.isLongRunning = true;
    this.scheduleRender(true);
    await this.flushRenderIfIdle();
  }

  async finishSucceeded(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'succeeded';
    this.isLongRunning = false;
    this.currentTool = null;
    this.toolLabelsByCallId.clear();
    await this.finish();
  }

  async finishFailed(errorMessage: string | null): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'failed';
    this.isLongRunning = false;
    this.currentTool = null;
    this.toolLabelsByCallId.clear();
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
    this.stopped = true;
    this.clearRenderTimer();
  }

  private shouldDeleteStartupOnlyProgressMessage(): boolean {
    return (
      this.phase === 'succeeded' &&
      this.progressMessageId !== null &&
      this.showStartupLine &&
      this.eventLogLines.length === 0 &&
      !this.hasPendingThinkingPreview
    );
  }

  private async deleteProgressMessage(): Promise<void> {
    const messageId = this.progressMessageId;
    if (messageId === null) {
      return;
    }

    try {
      await this.callWithRetry(() => this.options.bot.api.deleteMessage(this.options.chatId, messageId));
    } catch (error) {
      if (!isDeleteMessageGoneError(error)) {
        this.options.logger.warn({
          event: 'telegram_progress_delete_failed',
          run_id: this.options.runId,
          chat_id: this.options.chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.progressMessageId === messageId) {
        this.progressMessageId = null;
      }
      this.lastRenderedText = '';
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

    if (this.renderInFlight || !this.pendingRender) {
      return;
    }

    if (this.progressMessageId === null) {
      return;
    }

    this.renderInFlight = true;
    this.pendingRender = false;
    const text = this.renderProgressText();

    try {
      if (text === this.lastRenderedText) {
        return;
      }

      await this.options.bot.api.editMessageText(this.options.chatId, this.progressMessageId, text);
      this.lastRenderedText = text;
      this.lastEditAt = Date.now();
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        this.lastRenderedText = text;
        this.lastEditAt = Date.now();
      } else {
        const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
        if (retryAfterSeconds !== null) {
          this.nextEditAllowedAt = Date.now() + Math.ceil(retryAfterSeconds * 1000);
          this.pendingRender = true;
        } else if (isEditMessageGoneError(error)) {
          await this.recreateProgressMessage(text);
        } else {
          this.options.logger.warn({
            event: 'telegram_progress_edit_failed',
            run_id: this.options.runId,
            chat_id: this.options.chatId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.renderInFlight = false;
      if (this.pendingRender && !this.stopped) {
        this.scheduleRender();
      }
    }
  }

  private async recreateProgressMessage(text: string): Promise<void> {
    try {
      const message = await this.callWithRetry(() => this.options.bot.api.sendMessage(this.options.chatId, text));
      this.progressMessageId = message.message_id;
      this.lastRenderedText = text;
      this.lastEditAt = Date.now();
    } catch (error) {
      this.options.logger.warn({
        event: 'telegram_progress_recreate_failed',
        run_id: this.options.runId,
        chat_id: this.options.chatId,
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
      await this.options.bot.api.sendChatAction(this.options.chatId, 'typing');
    } catch (error) {
      const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
      if (retryAfterSeconds !== null) {
        this.nextTypingAllowedAt = Date.now() + Math.ceil(retryAfterSeconds * 1000);
        return;
      }

      this.options.logger.warn({
        event: 'telegram_typing_indicator_failed',
        run_id: this.options.runId,
        chat_id: this.options.chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private renderProgressText(): string {
    const lines: string[] = [];

    if (this.showStartupLine) {
      lines.push(this.startupLine);
    }

    lines.push(...this.eventLogLines);

    if (this.isLongRunning && this.phase === 'running') {
      lines.push("still running in background. i'll send the final response when done.");
    }

    if (this.phase === 'failed' && this.terminalErrorMessage) {
      lines.push(`error: ${truncateLine(this.terminalErrorMessage, 240)}`);
    }

    if (lines.length === 0) {
      lines.push('...');
    }

    return this.renderTrimmedLines(lines);
  }

  private flushThinkingPreviewToLog(now = Date.now()): boolean {
    if (!this.hasPendingThinkingPreview) {
      return false;
    }

    const thinkingSnippet = truncateLine(this.thinkingPreview, 220);
    if (thinkingSnippet.length === 0) {
      this.hasPendingThinkingPreview = false;
      this.lastThinkingLoggedAt = now;
      return false;
    }

    const line = truncateLine(`~ ${thinkingSnippet}`, maxProgressToolLabelChars);
    const lastIndex = this.eventLogLines.length - 1;
    if (lastIndex >= 0 && this.eventLogLines[lastIndex]?.startsWith('~ ')) {
      if (this.eventLogLines[lastIndex] !== line) {
        this.eventLogLines[lastIndex] = line;
        this.hasPendingThinkingPreview = false;
        this.lastThinkingLoggedAt = now;
        return true;
      }

      this.hasPendingThinkingPreview = false;
      this.lastThinkingLoggedAt = now;
      return false;
    }

    const appended = this.pushEventLogLine(line);
    this.hasPendingThinkingPreview = false;
    this.lastThinkingLoggedAt = now;
    return appended;
  }

  private pushEventLogLine(line: string): boolean {
    const normalizedLine = truncateLine(line, maxProgressToolLabelChars);
    if (normalizedLine.length === 0) {
      return false;
    }

    const lastLine = this.eventLogLines[this.eventLogLines.length - 1];
    if (lastLine === normalizedLine) {
      return false;
    }

    this.eventLogLines.push(normalizedLine);
    if (this.eventLogLines.length > maxEventLogLines) {
      this.eventLogLines = this.eventLogLines.slice(this.eventLogLines.length - maxEventLogLines);
    }

    return true;
  }

  private renderTrimmedLines(lines: string[]): string {
    if (lines.length === 0) {
      return '';
    }

    const bounded = [...lines];
    while (bounded.length > 1 && bounded.join('\n').length > this.messageLimit) {
      bounded.splice(1, 1);
    }

    return truncateMessage(bounded.join('\n'), this.messageLimit);
  }

  private clearRenderTimer(): void {
    if (!this.renderTimer) {
      return;
    }

    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private async callWithRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
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
}
