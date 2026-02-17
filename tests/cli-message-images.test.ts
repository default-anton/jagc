import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildMessageImagesFromPaths, detectImageMimeType } from '../src/cli/message-images.js';
import type { InputImageValidationError } from '../src/shared/input-images.js';

describe('buildMessageImagesFromPaths', () => {
  test('preserves image order and emits API payload fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagc-cli-images-'));
    const firstPath = join(dir, 'a.png');
    const secondPath = join(dir, 'b.jpg');

    try {
      await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]));
      await writeFile(secondPath, Buffer.from([0xff, 0xd8, 0xff, 0x42]));

      const images = await buildMessageImagesFromPaths([firstPath, secondPath]);

      expect(images).toHaveLength(2);
      expect(images[0]?.mime_type).toBe('image/png');
      expect(images[0]?.filename).toBe('a.png');
      expect(images[1]?.mime_type).toBe('image/jpeg');
      expect(images[1]?.filename).toBe('b.jpg');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects unsupported image type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagc-cli-images-'));
    const filePath = join(dir, 'bad.bin');

    try {
      await writeFile(filePath, Buffer.from('not-an-image'));

      await expect(buildMessageImagesFromPaths([filePath])).rejects.toMatchObject({
        code: 'image_mime_type_unsupported',
      } satisfies Partial<InputImageValidationError>);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects when image count exceeds limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagc-cli-images-'));

    try {
      const imagePaths: string[] = [];
      for (let index = 0; index < 11; index += 1) {
        const filePath = join(dir, `img-${index}.png`);
        imagePaths.push(filePath);
        await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]));
      }

      await expect(buildMessageImagesFromPaths(imagePaths)).rejects.toMatchObject({
        code: 'image_count_exceeded',
      } satisfies Partial<InputImageValidationError>);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('detectImageMimeType', () => {
  test('detects GIF and WEBP signatures', () => {
    expect(detectImageMimeType(Buffer.from('GIF89atest'))).toBe('image/gif');
    expect(detectImageMimeType(Buffer.from('RIFF____WEBP', 'ascii'))).toBe('image/webp');
  });
});
