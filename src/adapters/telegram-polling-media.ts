import { InputImageValidationError, maxInputImageTotalBytes } from '../shared/input-images.js';

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export function selectLargestTelegramPhoto(photoSizes: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (photoSizes.length === 0) {
    return null;
  }

  let selected = photoSizes[0] ?? null;
  if (!selected) {
    return null;
  }

  let selectedScore = (selected.file_size ?? 0) * 1_000_000 + selected.width * selected.height;

  for (const candidate of photoSizes.slice(1)) {
    const candidateScore = (candidate.file_size ?? 0) * 1_000_000 + candidate.width * candidate.height;
    if (candidateScore <= selectedScore) {
      continue;
    }

    selected = candidate;
    selectedScore = candidateScore;
  }

  return selected;
}

export function assertTelegramFileSizeWithinLimit(fileSize: number | undefined, imageKind: 'photo' | 'document'): void {
  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize <= 0) {
    return;
  }

  if (fileSize <= maxInputImageTotalBytes) {
    return;
  }

  throw new InputImageValidationError(
    'image_total_bytes_exceeded',
    `telegram ${imageKind} exceeds decoded payload limit (${maxInputImageTotalBytes} bytes max per image)`,
  );
}

export function buildTelegramFileUrl(telegramApiRoot: string, botToken: string, filePath: string): string {
  const encodedToken = encodeURIComponent(botToken);
  const encodedPath = filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${telegramApiRoot}/file/bot${encodedToken}/${encodedPath}`;
}
