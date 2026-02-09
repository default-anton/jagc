export const maxProgressToolLabelChars = 140;

export function summarizeToolLabel(
  toolName: string,
  payload: unknown,
  maxChars: number = maxProgressToolLabelChars,
): string {
  const hint = summarizePayloadHint(payload);
  if (!hint) {
    return truncateLine(toolName, maxChars);
  }

  return truncateLine(`${toolName} ${hint}`, maxChars);
}

export function normalizePreviewDelta(text: string): string {
  return text.replaceAll('\r', '');
}

export function appendTail(current: string, delta: string, maxChars: number): string {
  const combined = `${current}${delta}`;
  if (combined.length <= maxChars) {
    return combined;
  }

  return combined.slice(combined.length - maxChars);
}

export function truncateMessage(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 1) {
    return text.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - 1)}…`;
}

export function truncateLine(text: string, maxChars: number): string {
  const normalized = text.replaceAll('\n', ' ').trim();
  return truncateMessage(normalized, maxChars);
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function renderProgressStatusLabel(options: {
  phase: 'queued' | 'running' | 'succeeded' | 'failed';
  isLongRunning: boolean;
  currentToolLabel: string | null;
  lastThinkingAt: number;
  now: number;
}): { icon: string; text: string } {
  if (options.phase === 'queued') {
    return { icon: '⏳', text: 'Queued' };
  }

  if (options.phase === 'succeeded') {
    return { icon: '✅', text: 'Completed' };
  }

  if (options.phase === 'failed') {
    return { icon: '❌', text: 'Failed' };
  }

  if (options.currentToolLabel) {
    return { icon: '🔧', text: `Running ${options.currentToolLabel}` };
  }

  if (options.now - options.lastThinkingAt <= 8_000 && options.lastThinkingAt > 0) {
    return { icon: '🧠', text: 'Thinking' };
  }

  if (options.isLongRunning) {
    return { icon: '⏳', text: 'Running in background' };
  }

  return { icon: '⏳', text: 'Working' };
}

export function isEditMessageGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('message to edit not found') || message.includes("message can't be edited");
}

function summarizePayloadHint(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const value = payload as Record<string, unknown>;

  for (const key of ['path', 'file', 'command', 'query', 'text']) {
    const field = value[key];
    if (typeof field === 'string' && field.trim().length > 0) {
      return truncateLine(field.trim(), 90);
    }
  }

  return null;
}
