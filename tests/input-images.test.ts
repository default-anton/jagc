import { describe, expect, test } from 'vitest';
import {
  type DecodedInputImage,
  decodeAndValidateApiInputImages,
  InputImageValidationError,
  validateDecodedInputImages,
} from '../src/shared/input-images.js';

describe('input image validation', () => {
  test('decodes valid API image payload', () => {
    const decoded = decodeAndValidateApiInputImages([
      {
        mime_type: 'image/png',
        data_base64: Buffer.from('hello').toString('base64'),
        filename: 'hello.png',
      },
    ]);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.mimeType).toBe('image/png');
    expect(decoded[0]?.data.toString('utf8')).toBe('hello');
  });

  test('rejects invalid API base64 payload', () => {
    try {
      decodeAndValidateApiInputImages([
        {
          mime_type: 'image/png',
          data_base64: '---',
        },
      ]);
      throw new Error('expected decode to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InputImageValidationError);
      expect((error as InputImageValidationError).code).toBe('image_base64_invalid');
    }
  });

  test('rejects total bytes over configured limit', () => {
    try {
      decodeAndValidateApiInputImages(
        [
          {
            mime_type: 'image/png',
            data_base64: Buffer.from('12345').toString('base64'),
          },
        ],
        {
          maxCount: 10,
          maxTotalBytes: 4,
        },
      );
      throw new Error('expected decode to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InputImageValidationError);
      expect((error as InputImageValidationError).code).toBe('image_total_bytes_exceeded');
    }
  });

  test('rejects decoded images over configured count limit', () => {
    const images: DecodedInputImage[] = [
      { mimeType: 'image/png', data: Buffer.from('a') },
      { mimeType: 'image/jpeg', data: Buffer.from('b') },
    ];

    try {
      validateDecodedInputImages(images, {
        maxCount: 1,
        maxTotalBytes: 100,
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InputImageValidationError);
      expect((error as InputImageValidationError).code).toBe('image_count_exceeded');
    }
  });
});
