import type { IncomingMessage } from 'node:http';

const multipartAttachPrefix = 'attach://';

export async function readPayload(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBuffer = Buffer.concat(chunks);
  const rawText = rawBuffer.toString('utf8');
  if (rawText.trim().length === 0) {
    return {};
  }

  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    return parseMultipartPayload(rawBuffer, contentType);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = new URLSearchParams(rawText);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of parsed.entries()) {
      payload[key] = parseFormValue(value);
    }

    return payload;
  }

  const parsed = JSON.parse(rawText);
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

function parseMultipartPayload(rawBuffer: Buffer, contentType: string): Record<string, unknown> {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error('multipart/form-data boundary is missing');
  }

  const payload: Record<string, unknown> = {};
  const boundaryMarker = `--${boundary}`;
  const raw = rawBuffer.toString('latin1');
  const parts = raw.split(boundaryMarker);

  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || part.trim().length === 0) {
      continue;
    }

    const normalizedPart = part.startsWith('\r\n') ? part.slice(2) : part;
    const separatorIndex = normalizedPart.indexOf('\r\n\r\n');
    if (separatorIndex < 0) {
      throw new Error('multipart/form-data part missing header/body separator');
    }

    const rawHeaders = normalizedPart.slice(0, separatorIndex);
    let rawBody = normalizedPart.slice(separatorIndex + 4);
    if (rawBody.endsWith('\r\n')) {
      rawBody = rawBody.slice(0, -2);
    }

    const disposition = parseContentDisposition(rawHeaders);
    if (!disposition?.name) {
      throw new Error('multipart/form-data part missing content-disposition name');
    }

    const decodedBody = decodeMultipartBody(rawBody);

    if (disposition.filename) {
      payload[disposition.name] = {
        filename: disposition.filename,
        content: decodedBody,
      };
      continue;
    }

    payload[disposition.name] = parseFormValue(decodedBody);
  }

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'string' || !value.startsWith(multipartAttachPrefix)) {
      continue;
    }

    const attached = payload[value.slice(multipartAttachPrefix.length)];
    if (attached && typeof attached === 'object') {
      payload[key] = attached;
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error('multipart/form-data payload is empty or malformed');
  }

  return payload;
}

function decodeMultipartBody(rawBody: string): string {
  return Buffer.from(rawBody, 'latin1').toString('utf8');
}

function parseMultipartBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    return null;
  }

  return boundary.trim();
}

function parseContentDisposition(headers: string): { name: string | null; filename: string | null } | null {
  const lines = headers.split('\r\n');
  const dispositionLine = lines.find((line) => line.toLowerCase().startsWith('content-disposition:'));
  if (!dispositionLine) {
    return null;
  }

  const name = parseDispositionToken(dispositionLine, 'name');
  const filename =
    parseDispositionToken(dispositionLine, 'filename') ?? parseDispositionFilenameExtended(dispositionLine);

  return {
    name,
    filename,
  };
}

function parseDispositionToken(line: string, token: string): string | null {
  const match = line.match(new RegExp(`${token}="([^"]+)"`, 'i'));
  return match?.[1] ?? null;
}

function parseDispositionFilenameExtended(line: string): string | null {
  const match = line.match(/filename\*=([^;\r\n]+)/i);
  if (!match?.[1]) {
    return null;
  }

  return decodeDispositionFilename(match[1].trim());
}

function decodeDispositionFilename(raw: string): string {
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;

  const charsetMatch = unquoted.match(/^[^']*'[^']*'(.*)$/u);
  const encodedValue = charsetMatch?.[1] ?? unquoted;

  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return encodedValue;
  }
}
