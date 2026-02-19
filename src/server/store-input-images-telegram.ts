import type { DecodedInputImage } from '../shared/input-images.js';
import { isSqliteConstraintViolation } from './sqlite.js';

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
