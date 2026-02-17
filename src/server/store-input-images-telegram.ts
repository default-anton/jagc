import type { DecodedInputImage } from '../shared/input-images.js';

export const inputImagesTelegramUpdateIndexName = 'input_images_telegram_update_idx';

export interface PendingTelegramImageScope {
  source: string;
  threadKey: string;
  userKey: string;
}

export interface PendingTelegramImageIngest {
  source: string;
  threadKey: string;
  userKey: string;
  telegramUpdateId: number;
  telegramMediaGroupId?: string | null;
  images: DecodedInputImage[];
}

export interface PendingTelegramImageIngestResult {
  insertedCount: number;
  bufferedCount: number;
  bufferedBytes: number;
}

export function isTelegramUpdateDedupConstraint(error: unknown): boolean {
  if (!isSqliteConstraintViolation(error)) {
    return false;
  }

  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes(inputImagesTelegramUpdateIndexName);
}

function isSqliteConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
