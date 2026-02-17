import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PostMessageImageInput } from '../shared/api-contracts.js';
import {
  type DecodedInputImage,
  detectInputImageMimeType,
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
  return detectInputImageMimeType(bytes);
}
