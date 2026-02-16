import { describe, expect, test } from 'vitest';

import {
  normalizeTelegramMessageThreadId,
  telegramRoute,
  telegramRouteFromThreadKey,
  telegramThreadKeyFromRoute,
} from '../src/shared/telegram-threading.js';

describe('telegram threading helpers', () => {
  test('normalizes general topic thread id 1 to no thread id', () => {
    expect(normalizeTelegramMessageThreadId(1)).toBeUndefined();
    expect(telegramRoute(101, 1)).toEqual({ chatId: 101 });
    expect(telegramThreadKeyFromRoute({ chatId: 101, messageThreadId: 1 })).toBe('telegram:chat:101');
  });

  test('parses topic:1 thread keys as base chat threads', () => {
    expect(telegramRouteFromThreadKey('telegram:chat:101:topic:1')).toEqual({ chatId: 101 });
  });

  test('keeps non-general topic ids', () => {
    expect(normalizeTelegramMessageThreadId(333)).toBe(333);
    expect(telegramRoute(101, 333)).toEqual({ chatId: 101, messageThreadId: 333 });
    expect(telegramThreadKeyFromRoute({ chatId: 101, messageThreadId: 333 })).toBe('telegram:chat:101:topic:333');
  });
});
