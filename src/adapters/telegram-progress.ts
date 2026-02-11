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

interface ToolProgressState {
  label: string;
  startedAtMs: number;
  lineIndex: number | null;
}

const defaultMessageLimit = 3500;
const defaultMinEditIntervalMs = 1500;
const defaultTypingIntervalMs = 4000;
const archiveFlushMinChars = 1_800;
const progressArchiveHeader = 'progress log (continued):';
const maxThinkingPreviewChars = 240;
const maxDeltaChars = 200;
const minThinkingLogIntervalMs = 1_800;

function formatToolCompletionLabel(options: { label: string; isError: boolean; durationMs: number | null }): string {
  const status = options.isError ? '[✗] failed' : '[✓] done';
  const duration = options.durationMs === null ? null : formatToolDuration(options.durationMs);
  const durationSuffix = duration ? ` (${duration})` : '';
  return `> ${options.label} ${status}${durationSuffix}`;
}

function formatToolDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  return `${seconds.toFixed(1)}s`;
}

export class TelegramRunProgressReporter {
  private readonly messageLimit: number;
  private readonly minEditIntervalMs: number;
  private readonly typingIntervalMs: number;
  private readonly startupLine = pickProgressStartupLine();

  private phase: ProgressPhase = 'queued';
  private showStartupLine = true;
  private terminalErrorMessage: string | null = null;

  private lastThinkingLoggedAt = 0;
  private thinkingPreview = '';
  private hasPendingThinkingPreview = false;

  private readonly toolProgressByCallId = new Map<string, ToolProgressState>();
  private eventLogLines: string[] = [];
  private pendingArchiveLines: string[] = [];

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
        const lineIndex = this.appendEventLogLine(`> ${label}`);
        this.toolProgressByCallId.set(event.toolCallId, {
          label,
          startedAtMs: Date.now(),
          lineIndex,
        });
        immediateRender = lineIndex !== null || immediateRender;
        break;
      }
      case 'tool_execution_update': {
        this.phase = 'running';
        break;
      }
      case 'tool_execution_end': {
        this.phase = 'running';
        this.showStartupLine = false;

        const toolState = this.toolProgressByCallId.get(event.toolCallId);
        const label = toolState?.label ?? summarizeToolLabel(event.toolName, undefined);
        const durationMs = toolState ? Date.now() - toolState.startedAtMs : null;
        this.toolProgressByCallId.delete(event.toolCallId);

        const completionLabel = formatToolCompletionLabel({
          label,
          isError: event.isError,
          durationMs,
        });

        if (typeof toolState?.lineIndex === 'number') {
          immediateRender = this.replaceEventLogLine(toolState.lineIndex, completionLabel) || immediateRender;
        } else {
          immediateRender = this.pushEventLogLine(completionLabel) || immediateRender;
        }
        break;
      }
      case 'succeeded': {
        this.phase = 'succeeded';
        immediateRender = true;
        this.toolProgressByCallId.clear();
        this.terminalErrorMessage = null;
        break;
      }
      case 'failed': {
        this.phase = 'failed';
        immediateRender = true;
        this.toolProgressByCallId.clear();
        this.terminalErrorMessage = event.errorMessage;
        break;
      }
      case 'agent_end': {
        if (this.phase !== 'succeeded' && this.phase !== 'failed') {
          this.phase = 'running';
        }
        this.toolProgressByCallId.clear();
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
    this.toolProgressByCallId.clear();
    await this.finish();
  }

  async finishFailed(errorMessage: string | null): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'failed';
    this.toolProgressByCallId.clear();
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

    if (this.pendingRender && this.pendingArchiveLines.length > 0) {
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

    let text = this.lastRenderedText;

    try {
      this.archiveOverflowEventLogLines();
      await this.flushPendingArchiveLines(this.phase === 'succeeded' || this.phase === 'failed');

      text = this.renderProgressText();
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

          if (this.pendingArchiveLines.length > 0) {
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
    return this.renderTrimmedLines(this.buildProgressLines());
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
    return this.appendEventLogLine(line) !== null;
  }

  private appendEventLogLine(line: string): number | null {
    const normalizedLine = truncateLine(line, maxProgressToolLabelChars);
    if (normalizedLine.length === 0) {
      return null;
    }

    const lastLine = this.eventLogLines[this.eventLogLines.length - 1];
    if (lastLine === normalizedLine) {
      return null;
    }

    this.eventLogLines.push(normalizedLine);
    return this.eventLogLines.length - 1;
  }

  private replaceEventLogLine(index: number, line: string): boolean {
    if (index < 0 || index >= this.eventLogLines.length) {
      return false;
    }

    const normalizedLine = truncateLine(line, maxProgressToolLabelChars);
    if (normalizedLine.length === 0) {
      return false;
    }

    if (this.eventLogLines[index] === normalizedLine) {
      return false;
    }

    this.eventLogLines[index] = normalizedLine;
    return true;
  }

  private archiveOverflowEventLogLines(): void {
    while (this.eventLogLines.length > 0 && this.renderProgressLength() > this.messageLimit) {
      const archivedLine = this.eventLogLines.shift();
      if (!archivedLine) {
        break;
      }

      this.queueArchiveLine(archivedLine);
      this.shiftTrackedToolLineIndexes(1);
    }
  }

  private renderProgressLength(): number {
    const lines = this.buildProgressLines();
    return lines.join('\n').length;
  }

  private buildProgressLines(): string[] {
    const lines: string[] = [];

    if (this.showStartupLine) {
      lines.push(this.startupLine);
    }

    lines.push(...this.eventLogLines);

    if (this.phase === 'failed' && this.terminalErrorMessage) {
      lines.push(`error: ${truncateLine(this.terminalErrorMessage, 240)}`);
    }

    if (lines.length === 0) {
      lines.push('...');
    }

    return lines;
  }

  private shiftTrackedToolLineIndexes(removeCount: number): void {
    if (removeCount <= 0) {
      return;
    }

    for (const toolState of this.toolProgressByCallId.values()) {
      if (toolState.lineIndex === null) {
        continue;
      }

      const shiftedIndex = toolState.lineIndex - removeCount;
      toolState.lineIndex = shiftedIndex >= 0 ? shiftedIndex : null;
    }
  }

  private queueArchiveLine(line: string): void {
    if (line.length === 0) {
      return;
    }

    this.pendingArchiveLines.push(line);
  }

  private pendingArchiveLength(): number {
    if (this.pendingArchiveLines.length === 0) {
      return 0;
    }

    return this.pendingArchiveLines.join('\n').length;
  }

  private async flushPendingArchiveLines(force: boolean): Promise<void> {
    if (this.pendingArchiveLines.length === 0) {
      return;
    }

    if (!force && this.pendingArchiveLength() < archiveFlushMinChars) {
      return;
    }

    const chunks = chunkArchiveLines(this.pendingArchiveLines, this.messageLimit, progressArchiveHeader);
    if (chunks.length === 0) {
      this.pendingArchiveLines = [];
      return;
    }

    for (const chunk of chunks) {
      await this.callWithRetry(() => this.options.bot.api.sendMessage(this.options.chatId, chunk.text));
      this.pendingArchiveLines.splice(0, chunk.lineCount);
    }
  }

  private renderTrimmedLines(lines: string[]): string {
    if (lines.length === 0) {
      return '';
    }

    return truncateMessage(lines.join('\n'), this.messageLimit);
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

interface ArchiveChunk {
  text: string;
  lineCount: number;
}

function chunkArchiveLines(lines: string[], maxLength: number, header: string): ArchiveChunk[] {
  if (lines.length === 0) {
    return [];
  }

  const chunks: ArchiveChunk[] = [];
  let current = '';
  let currentLineCount = 0;

  const headerPrefix = `${header}\n`;

  for (const line of lines) {
    const normalizedLine = truncateLine(line, maxProgressToolLabelChars);
    if (normalizedLine.length === 0) {
      continue;
    }

    const withLine = current.length === 0 ? normalizedLine : `${current}\n${normalizedLine}`;
    const wrappedWithLine = `${headerPrefix}${withLine}`;

    if (wrappedWithLine.length <= maxLength) {
      current = withLine;
      currentLineCount += 1;
      continue;
    }

    if (current.length > 0) {
      chunks.push({
        text: truncateMessage(`${headerPrefix}${current}`, maxLength),
        lineCount: currentLineCount,
      });
      current = normalizedLine;
      currentLineCount = 1;
      continue;
    }

    chunks.push({
      text: truncateMessage(`${headerPrefix}${normalizedLine}`, maxLength),
      lineCount: 1,
    });
    current = '';
    currentLineCount = 0;
  }

  if (current.length > 0) {
    chunks.push({
      text: truncateMessage(`${headerPrefix}${current}`, maxLength),
      lineCount: currentLineCount,
    });
  }

  return chunks;
}
