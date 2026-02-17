import { chunkArchiveLines } from './telegram-progress-archive.js';
import {
  appendTail,
  maxProgressToolLabelChars,
  normalizePreviewDelta,
  summarizeToolLabel,
  truncateLine,
} from './telegram-progress-helpers.js';

type ProgressPhase = 'queued' | 'running' | 'succeeded' | 'failed';

interface ToolProgressState {
  label: string;
  startedAtMs: number;
  lineIndex: number | null;
}

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

export class TelegramProgressLog {
  private showStartupLine = true;

  private lastThinkingLoggedAt = 0;
  private thinkingPreview = '';
  private hasPendingThinkingPreview = false;
  private lastThinkingContentIndex: number | null = null;
  private forceAppendNextThinkingLine = false;

  private readonly toolProgressByCallId = new Map<string, ToolProgressState>();
  private eventLogLines: string[] = [];
  private pendingArchiveLines: string[] = [];

  get lines(): string[] {
    return this.eventLogLines;
  }

  get archivedLines(): string[] {
    return this.pendingArchiveLines;
  }

  set archivedLines(lines: string[]) {
    this.pendingArchiveLines = lines;
  }

  closeThinkingSegmentIfNeeded(): boolean {
    const shouldCloseThinkingSegment = this.hasPendingThinkingPreview || this.thinkingPreview.trim().length > 0;
    const changed = this.flushThinkingPreviewToLog();
    if (shouldCloseThinkingSegment) {
      this.markThinkingSegmentBoundary();
    }

    return changed;
  }

  onThinkingDelta(deltaText: string, contentIndex: number | undefined, now = Date.now()): boolean {
    const delta = normalizePreviewDelta(deltaText);
    if (delta.trim().length === 0) {
      return false;
    }

    this.showStartupLine = false;

    let changed = false;
    if (typeof contentIndex === 'number' && Number.isFinite(contentIndex)) {
      if (this.lastThinkingContentIndex !== null && this.lastThinkingContentIndex !== contentIndex) {
        changed = this.flushThinkingPreviewToLog(now) || changed;
        this.markThinkingSegmentBoundary();
      }

      this.lastThinkingContentIndex = contentIndex;
    }

    this.thinkingPreview = appendTail(this.thinkingPreview, delta.slice(-maxDeltaChars), maxThinkingPreviewChars);
    this.hasPendingThinkingPreview = true;
    if (now - this.lastThinkingLoggedAt >= minThinkingLogIntervalMs) {
      changed = this.flushThinkingPreviewToLog(now) || changed;
    }

    return changed;
  }

  onToolExecutionStart(toolCallId: string, toolName: string, args: unknown): boolean {
    this.showStartupLine = false;
    const label = summarizeToolLabel(toolName, args);
    const lineIndex = this.appendEventLogLine(`> ${label}`);
    this.toolProgressByCallId.set(toolCallId, {
      label,
      startedAtMs: Date.now(),
      lineIndex,
    });

    return lineIndex !== null;
  }

  onToolExecutionEnd(toolCallId: string, toolName: string, isError: boolean): boolean {
    this.showStartupLine = false;

    const toolState = this.toolProgressByCallId.get(toolCallId);
    const label = toolState?.label ?? summarizeToolLabel(toolName, undefined);
    const durationMs = toolState ? Date.now() - toolState.startedAtMs : null;
    this.toolProgressByCallId.delete(toolCallId);

    const completionLabel = formatToolCompletionLabel({
      label,
      isError,
      durationMs,
    });

    if (typeof toolState?.lineIndex === 'number') {
      return this.replaceEventLogLine(toolState.lineIndex, completionLabel);
    }

    return this.pushEventLogLine(completionLabel);
  }

  clearToolProgress(): void {
    this.toolProgressByCallId.clear();
  }

  archiveOverflowEventLogLines(renderLength: () => number): void {
    while (this.eventLogLines.length > 0 && renderLength() > this.messageLengthLimitHint) {
      const archivedLine = this.eventLogLines.shift();
      if (!archivedLine) {
        break;
      }

      this.queueArchiveLine(archivedLine);
      this.shiftTrackedToolLineIndexes(1);
    }
  }

  private messageLengthLimitHint = Number.POSITIVE_INFINITY;

  setMessageLimitHint(messageLimit: number): void {
    this.messageLengthLimitHint = messageLimit;
  }

  buildProgressLines(options: {
    phase: ProgressPhase;
    startupLine: string;
    terminalErrorMessage: string | null;
  }): string[] {
    const lines: string[] = [];

    if (this.showStartupLine) {
      lines.push(options.startupLine);
    }

    lines.push(...this.eventLogLines);

    if (options.phase === 'failed' && options.terminalErrorMessage) {
      lines.push(`error: ${truncateLine(options.terminalErrorMessage, 240)}`);
    }

    if (lines.length === 0) {
      lines.push('...');
    }

    return lines;
  }

  shouldDeleteStartupOnlyProgressMessage(phase: ProgressPhase): boolean {
    return (
      phase === 'succeeded' &&
      this.showStartupLine &&
      this.eventLogLines.length === 0 &&
      !this.hasPendingThinkingPreview
    );
  }

  hasPendingArchiveLines(): boolean {
    return this.pendingArchiveLines.length > 0;
  }

  async flushPendingArchiveLines(options: {
    force: boolean;
    messageLimit: number;
    sendChunk: (text: string) => Promise<void>;
  }): Promise<void> {
    if (this.pendingArchiveLines.length === 0) {
      return;
    }

    if (!options.force && this.pendingArchiveLength() < archiveFlushMinChars) {
      return;
    }

    const chunks = chunkArchiveLines(this.pendingArchiveLines, options.messageLimit, progressArchiveHeader);
    if (chunks.length === 0) {
      this.pendingArchiveLines = [];
      return;
    }

    for (const chunk of chunks) {
      await options.sendChunk(chunk.text);
      this.pendingArchiveLines.splice(0, chunk.lineCount);
    }
  }

  private markThinkingSegmentBoundary(): void {
    this.thinkingPreview = '';
    this.hasPendingThinkingPreview = false;
    this.lastThinkingContentIndex = null;
    this.forceAppendNextThinkingLine = true;
  }

  flushThinkingPreviewToLog(now = Date.now()): boolean {
    if (!this.hasPendingThinkingPreview) {
      return false;
    }

    const thinkingSnippet = truncateLine(this.thinkingPreview, 220);
    if (thinkingSnippet.length === 0) {
      this.hasPendingThinkingPreview = false;
      this.lastThinkingLoggedAt = now;
      this.forceAppendNextThinkingLine = false;
      return false;
    }

    const line = truncateLine(`~ ${thinkingSnippet}`, maxProgressToolLabelChars);
    const canReplaceLastThinkingLine = !this.forceAppendNextThinkingLine;
    const lastIndex = this.eventLogLines.length - 1;
    if (canReplaceLastThinkingLine && lastIndex >= 0 && this.eventLogLines[lastIndex]?.startsWith('~ ')) {
      if (this.eventLogLines[lastIndex] !== line) {
        this.eventLogLines[lastIndex] = line;
        this.hasPendingThinkingPreview = false;
        this.lastThinkingLoggedAt = now;
        this.forceAppendNextThinkingLine = false;
        return true;
      }

      this.hasPendingThinkingPreview = false;
      this.lastThinkingLoggedAt = now;
      this.forceAppendNextThinkingLine = false;
      return false;
    }

    const appended = this.pushEventLogLine(line);
    this.hasPendingThinkingPreview = false;
    this.lastThinkingLoggedAt = now;
    this.forceAppendNextThinkingLine = false;
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
}
