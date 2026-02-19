import { describe, expect, test } from 'vitest';

import {
  normalizeTelegramMessageThreadId,
  telegramBotApiRoutePayload,
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

  test('formats Telegram Bot API route payloads with normalized thread id', () => {
    expect(telegramBotApiRoutePayload({ chatId: 101 })).toEqual({ chat_id: 101 });
    expect(telegramBotApiRoutePayload({ chatId: 101, messageThreadId: 1 })).toEqual({ chat_id: 101 });
    expect(telegramBotApiRoutePayload({ chatId: 101, messageThreadId: 333 })).toEqual({
      chat_id: 101,
      message_thread_id: 333,
    });
  });
});
