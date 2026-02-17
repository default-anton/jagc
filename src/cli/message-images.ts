import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PostMessageImageInput } from '../shared/api-contracts.js';
import {
  type DecodedInputImage,
  encodeDecodedInputImagesForApi,
  InputImageValidationError,
  validateDecodedInputImages,
} from '../shared/input-images.js';

export async function buildMessageImagesFromPaths(imagePaths: string[]): Promise<PostMessageImageInput[]> {
  if (imagePaths.length === 0) {
    return [];
  }

  const decodedImages: DecodedInputImage[] = [];

  for (const imagePath of imagePaths) {
    const bytes = await readFile(imagePath);
    const mimeType = detectImageMimeType(bytes);

    if (!mimeType) {
      throw new InputImageValidationError(
        'image_mime_type_unsupported',
        `file has unsupported image type: ${imagePath}`,
      );
    }

    decodedImages.push({
      mimeType,
      data: bytes,
      filename: basename(imagePath),
    });
  }

  validateDecodedInputImages(decodedImages);
  return encodeDecodedInputImagesForApi(decodedImages);
}

export function detectImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }

  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}
