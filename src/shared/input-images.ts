import { createHash } from 'node:crypto';

export const inputImageMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const maxInputImageCount = 10;
export const maxInputImageTotalBytes = 50 * 1024 * 1024;
export const messageIngressBodyLimitBytes = 75 * 1024 * 1024;
export const inputImageTtlMs = 3 * 24 * 60 * 60 * 1000;

const inputImageMimeTypeSet = new Set<string>(inputImageMimeTypes);

export const inputImageValidationCodes = [
  'image_count_exceeded',
  'image_total_bytes_exceeded',
  'image_mime_type_unsupported',
  'image_base64_invalid',
] as const;

export type InputImageValidationCode = (typeof inputImageValidationCodes)[number];

const sha256Algorithm = 'sha256';
const base64CharacterPattern = /^[A-Za-z0-9+/=]+$/u;
const base64PaddingPattern = /^=+$/u;

export interface ApiInputImage {
  mime_type: string;
  data_base64: string;
  filename?: string;
}

export interface DecodedInputImage {
  mimeType: string;
  data: Buffer;
  filename?: string | null;
}

export interface InputImageValidationLimits {
  maxCount: number;
  maxTotalBytes: number;
}

const defaultInputImageValidationLimits: InputImageValidationLimits = {
  maxCount: maxInputImageCount,
  maxTotalBytes: maxInputImageTotalBytes,
};

export class InputImageValidationError extends Error {
  constructor(
    readonly code: InputImageValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'InputImageValidationError';
  }
}

export function decodeAndValidateApiInputImages(
  images: ApiInputImage[] | undefined,
  limits: InputImageValidationLimits = defaultInputImageValidationLimits,
): DecodedInputImage[] {
  if (!images || images.length === 0) {
    return [];
  }

  assertImageCountWithinLimit(images.length, limits);

  const decoded: DecodedInputImage[] = [];
  let totalBytes = 0;

  for (const [index, image] of images.entries()) {
    const mimeType = image.mime_type.trim();
    assertMimeTypeSupported(mimeType, index);

    const bytes = decodeBase64OrThrow(image.data_base64, index);
    totalBytes += bytes.byteLength;
    assertTotalBytesWithinLimit(totalBytes, limits);

    decoded.push({
      mimeType,
      data: bytes,
      filename: normalizeFilename(image.filename),
    });
  }

  return decoded;
}

export function validateDecodedInputImages(
  images: DecodedInputImage[],
  limits: InputImageValidationLimits = defaultInputImageValidationLimits,
): void {
  assertImageCountWithinLimit(images.length, limits);

  let totalBytes = 0;

  for (const [index, image] of images.entries()) {
    assertMimeTypeSupported(image.mimeType, index);

    totalBytes += image.data.byteLength;
    assertTotalBytesWithinLimit(totalBytes, limits);
  }
}

export function computeInputImagesTotalBytes(images: readonly DecodedInputImage[]): number {
  return images.reduce((sum, image) => sum + image.data.byteLength, 0);
}

export function isInputImageMimeTypeSupported(mimeType: string): boolean {
  return inputImageMimeTypeSet.has(mimeType);
}

export function encodeDecodedInputImagesForApi(images: readonly DecodedInputImage[]): ApiInputImage[] {
  return images.map((image) => ({
    mime_type: image.mimeType,
    data_base64: image.data.toString('base64'),
    ...(image.filename ? { filename: image.filename } : {}),
  }));
}

export function hashMessageIngestPayload(input: {
  threadKey: string;
  text: string;
  deliveryMode: string;
  images?: readonly DecodedInputImage[];
}): string {
  const payload = {
    thread_key: input.threadKey,
    text: input.text,
    delivery_mode: input.deliveryMode,
    images: (input.images ?? []).map((image) => ({
      mime_type: image.mimeType,
      filename: image.filename ?? null,
      data_sha256: createHash(sha256Algorithm).update(image.data).digest('hex'),
    })),
  };

  return createHash(sha256Algorithm).update(JSON.stringify(payload)).digest('hex');
}

export function expiresAtFromIsoTimestamp(createdAtIso: string, ttlMs: number = inputImageTtlMs): string {
  const createdAtMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(`invalid timestamp: ${createdAtIso}`);
  }

  return new Date(createdAtMs + ttlMs).toISOString();
}

function decodeBase64OrThrow(dataBase64: string, index: number): Buffer {
  const trimmed = dataBase64.trim();
  if (trimmed.length === 0 || trimmed !== dataBase64) {
    throw invalidBase64Error(index);
  }

  if (!base64CharacterPattern.test(trimmed)) {
    throw invalidBase64Error(index);
  }

  const firstPaddingIndex = trimmed.indexOf('=');
  if (firstPaddingIndex >= 0) {
    const padding = trimmed.slice(firstPaddingIndex);
    if (!base64PaddingPattern.test(padding) || padding.length > 2) {
      throw invalidBase64Error(index);
    }
  }

  const noPadding = trimmed.replace(/=+$/u, '');
  if (noPadding.length === 0) {
    throw invalidBase64Error(index);
  }

  const padded = `${noPadding}${'='.repeat((4 - (noPadding.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.byteLength === 0) {
    throw invalidBase64Error(index);
  }

  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  if (canonical !== noPadding) {
    throw invalidBase64Error(index);
  }

  return decoded;
}

function assertImageCountWithinLimit(count: number, limits: InputImageValidationLimits): void {
  if (count <= limits.maxCount) {
    return;
  }

  throw new InputImageValidationError(
    'image_count_exceeded',
    `image count exceeds limit (${limits.maxCount} max per message)`,
  );
}

function assertTotalBytesWithinLimit(totalBytes: number, limits: InputImageValidationLimits): void {
  if (totalBytes <= limits.maxTotalBytes) {
    return;
  }

  throw new InputImageValidationError(
    'image_total_bytes_exceeded',
    `decoded image payload exceeds limit (${limits.maxTotalBytes} bytes max per message)`,
  );
}

function assertMimeTypeSupported(mimeType: string, index: number): void {
  if (isInputImageMimeTypeSupported(mimeType)) {
    return;
  }

  throw new InputImageValidationError(
    'image_mime_type_unsupported',
    `images[${index}] has unsupported mime_type: ${mimeType}`,
  );
}

function normalizeFilename(filename: string | undefined): string | null {
  return filename?.trim() || null;
}

function invalidBase64Error(index: number): InputImageValidationError {
  return new InputImageValidationError('image_base64_invalid', `images[${index}] has invalid base64 data`);
}
