export const maxProgressToolLabelChars = 180;

const progressStartupLines = [
  'thinking...',
  'pondering...',
  'pontificating...',
  'ruminating...',
  'scheming...',
  'noodling...',
  'conjuring...',
  'wizarding...',
  'calculating...',
  'brainstormulating...',
  'plotting...',
  'synthesizing...',
  'brainweaving...',
  'daydreaming...',
  'freestyling...',
  'juggling...',
  'moonwalking...',
  'spelunking...',
  'tinkering...',
  'orchestrating...',
  'harmonizing...',
  'improvising...',
  'scribbling...',
  'whittling...',
  'refactoring...',
  'calibrating...',
  'optimizing...',
  'triangulating...',
  'decoding...',
  'untangling...',
  'stargazing...',
  'alchemizing...',
  'clockworking...',
  'mapmaking...',
  'narrating...',
  'riffing...',
  'ideating...',
  'debugomancy...',
  'foreshadowing...',
  'compiling...',
];

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

export function pickProgressStartupLine(randomValue: number = Math.random()): string {
  const normalized = Number.isFinite(randomValue) ? randomValue - Math.floor(randomValue) : 0;
  const index = Math.min(progressStartupLines.length - 1, Math.floor(normalized * progressStartupLines.length));
  return progressStartupLines[index] ?? progressStartupLines[0] ?? 'thinking...';
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
