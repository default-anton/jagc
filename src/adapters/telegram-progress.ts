import { setTimeout as sleep } from 'node:timers/promises';

import type { Bot } from 'grammy';
import type { Logger } from '../shared/logger.js';
import type { RunProgressEvent } from '../shared/run-progress.js';
import { extractTelegramRetryAfterSeconds, isTelegramMessageNotModifiedError } from './telegram-api-errors.js';
import {
  appendTail,
  formatDuration,
  isEditMessageGoneError,
  maxProgressToolLabelChars,
  normalizePreviewDelta,
  renderProgressStatusLabel,
  summarizeToolLabel,
  truncateLine,
  truncateMessage,
} from './telegram-progress-helpers.js';

type DeliveryMode = 'steer' | 'followUp';

type ProgressPhase = 'queued' | 'running' | 'succeeded' | 'failed';

interface TelegramRunProgressReporterOptions {
  bot: Bot;
  chatId: number;
  runId: string;
  deliveryMode: DeliveryMode;
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
const maxRecentTools = 3;
const maxPreviewChars = 320;
const maxDeltaChars = 200;

export class TelegramRunProgressReporter {
  private readonly startedAt = Date.now();
  private readonly messageLimit: number;
  private readonly minEditIntervalMs: number;
  private readonly typingIntervalMs: number;

  private phase: ProgressPhase = 'queued';
  private isLongRunning = false;
  private terminalErrorMessage: string | null = null;

  private turnCount = 0;
  private toolCount = 0;
  private toolErrorCount = 0;
  private thinkingDeltaChars = 0;
  private lastThinkingAt = 0;
  private textPreview = '';

  private currentTool: CurrentToolState | null = null;
  private recentTools: string[] = [];

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
        this.turnCount += 1;
        break;
      }
      case 'assistant_text_delta': {
        this.phase = 'running';
        const delta = normalizePreviewDelta(event.delta);
        if (delta.length > 0) {
          this.textPreview = appendTail(this.textPreview, delta.slice(-maxDeltaChars), maxPreviewChars);
        }
        break;
      }
      case 'assistant_thinking_delta': {
        this.phase = 'running';
        this.lastThinkingAt = Date.now();
        this.thinkingDeltaChars += event.delta.length;
        break;
      }
      case 'tool_execution_start': {
        this.phase = 'running';
        this.toolCount += 1;
        this.currentTool = {
          toolCallId: event.toolCallId,
          label: summarizeToolLabel(event.toolName, event.args),
        };
        break;
      }
      case 'tool_execution_update': {
        this.phase = 'running';
        if (this.currentTool?.toolCallId === event.toolCallId) {
          this.currentTool = {
            toolCallId: event.toolCallId,
            label: summarizeToolLabel(event.toolName, event.partialResult),
          };
        }
        break;
      }
      case 'tool_execution_end': {
        this.phase = 'running';
        const label = summarizeToolLabel(event.toolName, event.result);

        if (event.isError) {
          this.toolErrorCount += 1;
          this.pushRecentTool(`❌ ${label}`);
        } else {
          this.pushRecentTool(`✅ ${label}`);
        }

        if (this.currentTool?.toolCallId === event.toolCallId) {
          this.currentTool = null;
        }
        break;
      }
      case 'succeeded': {
        this.phase = 'succeeded';
        this.isLongRunning = false;
        this.currentTool = null;
        this.terminalErrorMessage = null;
        break;
      }
      case 'failed': {
        this.phase = 'failed';
        this.isLongRunning = false;
        this.currentTool = null;
        this.terminalErrorMessage = event.errorMessage;
        break;
      }
      case 'agent_end': {
        if (this.phase !== 'succeeded' && this.phase !== 'failed') {
          this.phase = 'running';
        }
        this.currentTool = null;
        break;
      }
    }

    this.scheduleRender();
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
    await this.finish();
  }

  async finishFailed(errorMessage: string | null): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.phase = 'failed';
    this.isLongRunning = false;
    this.currentTool = null;
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
    this.scheduleRender(true);
    await this.flushRenderIfIdle();
    this.stopped = true;
    this.clearRenderTimer();
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
    const now = Date.now();
    const elapsed = formatDuration(now - this.startedAt);
    const status = renderProgressStatusLabel({
      phase: this.phase,
      isLongRunning: this.isLongRunning,
      currentToolLabel: this.currentTool?.label ?? null,
      lastThinkingAt: this.lastThinkingAt,
      now,
    });

    const lines: string[] = [
      `${status.icon} Run ${this.options.runId} · ${elapsed}`,
      `Status: ${status.text}`,
      `Mode: ${this.options.deliveryMode}`,
      `Turns: ${this.turnCount} · Tools: ${this.toolCount} · Tool errors: ${this.toolErrorCount}`,
    ];

    if (this.currentTool) {
      lines.push(`Current tool: ${this.currentTool.label}`);
    }

    if (this.recentTools.length > 0) {
      lines.push('Recent tools:');
      for (const toolLine of this.recentTools) {
        lines.push(`- ${toolLine}`);
      }
    }

    if (this.textPreview.trim().length > 0) {
      lines.push('Draft preview:');
      lines.push(this.textPreview.trim());
    }

    if (this.phase === 'running' && this.lastThinkingAt > 0) {
      lines.push(`Thinking activity: ${this.thinkingDeltaChars} chars`);
    }

    if (this.isLongRunning && this.phase === 'running') {
      lines.push('Still running in background. I will send the final response when done.');
    }

    if (this.phase === 'failed' && this.terminalErrorMessage) {
      lines.push(`Error: ${truncateLine(this.terminalErrorMessage, 240)}`);
    }

    const text = lines.join('\n');
    return truncateMessage(text, this.messageLimit);
  }

  private pushRecentTool(line: string): void {
    this.recentTools.unshift(truncateLine(line, maxProgressToolLabelChars));
    if (this.recentTools.length > maxRecentTools) {
      this.recentTools = this.recentTools.slice(0, maxRecentTools);
    }
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
