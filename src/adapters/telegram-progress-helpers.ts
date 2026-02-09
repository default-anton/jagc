export const maxProgressToolLabelChars = 180;

export function summarizeToolLabel(
  toolName: string,
  payload: unknown,
  maxChars: number = maxProgressToolLabelChars,
): string {
  const argsHint = summarizeToolArgs(toolName, payload);
  if (!argsHint) {
    return truncateLine(toolName, maxChars);
  }

  return truncateLine(`${toolName} ${argsHint}`, maxChars);
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
}): { text: string } {
  if (options.phase === 'queued') {
    return { text: 'queued' };
  }

  if (options.phase === 'succeeded') {
    return { text: 'done' };
  }

  if (options.phase === 'failed') {
    return { text: 'failed' };
  }

  if (options.currentToolLabel) {
    return { text: 'using a tool' };
  }

  if (options.now - options.lastThinkingAt <= 8_000 && options.lastThinkingAt > 0) {
    return { text: 'thinking' };
  }

  if (options.isLongRunning) {
    return { text: 'running in background' };
  }

  return { text: 'working' };
}

export function isEditMessageGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('message to edit not found') || message.includes("message can't be edited");
}

function summarizeToolArgs(toolName: string, payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const path = readString(payload.path);
  const command = readString(payload.command);

  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    if (path) {
      return `path=${truncateLine(path, 96)}`;
    }

    return null;
  }

  if (toolName === 'bash') {
    if (command) {
      return `cmd=${quoteSnippet(command, 120)}`;
    }

    return null;
  }

  if (toolName === 'workflow_subagent') {
    const workflowSlug = readString(payload.workflowSlug);
    const nodeSlug = readString(payload.nodeSlug);
    const parts = [
      workflowSlug ? `workflow=${truncateLine(workflowSlug, 40)}` : null,
      nodeSlug ? `node=${truncateLine(nodeSlug, 40)}` : null,
    ].filter((part): part is string => part !== null);

    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  for (const key of ['path', 'command', 'query', 'task', 'url', 'text']) {
    const value = readString(payload[key]);
    if (!value) {
      continue;
    }

    if (key === 'command') {
      return `cmd=${quoteSnippet(value, 120)}`;
    }

    if (key === 'path') {
      return `path=${truncateLine(value, 96)}`;
    }

    return `${key}=${quoteSnippet(value, 100)}`;
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

function quoteSnippet(value: string, maxChars: number): string {
  return `"${truncateLine(value, maxChars)}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
