import type { IncomingMessage } from 'node:http';

export async function readPayload(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    return {};
  }

  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = new URLSearchParams(raw);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of parsed.entries()) {
      payload[key] = parseFormValue(value);
    }

    return payload;
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON payload must be an object');
  }

  return parsed as Record<string, unknown>;
}

export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 100;
  }

  return Math.max(1, Math.min(Math.floor(limit), 100));
}

export function updateTypeAllowed(update: Record<string, unknown>, allowedUpdates: string[] | undefined): boolean {
  if (!allowedUpdates || allowedUpdates.length === 0) {
    return true;
  }

  for (const allowedType of allowedUpdates) {
    if (allowedType in update) {
      return true;
    }
  }

  return false;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseFormValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
