import { describe, expect, test } from 'vitest';

import { TelegramBotApiClone } from './helpers/telegram-bot-api-clone.js';
import { telegramTestBotToken as testBotToken } from './helpers/telegram-test-kit.js';

describe('TelegramBotApiClone', () => {
  test('getUpdates respects allowed_updates filters without busy-looping the event loop', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      clone.injectCallbackQuery({
        chatId: 1,
        fromId: 2,
        data: 'm:providers:0',
      });

      const updatesPromise = apiCall<Array<Record<string, unknown>>>(clone, 'getUpdates', {
        allowed_updates: ['message'],
        timeout: 0.2,
      });

      const timerStartedAt = Date.now();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      const timerElapsedMs = Date.now() - timerStartedAt;

      const updates = await updatesPromise;
      expect(updates).toEqual([]);
      expect(timerElapsedMs).toBeLessThan(120);
    } finally {
      await clone.stop();
    }
  });

  test('parses urlencoded JSON payloads for sendMessage', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      const body = new URLSearchParams({
        chat_id: '101',
        text: 'hello',
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: 'Pick', callback_data: 'm:providers:0' }]],
        }),
      });

      const response = await fetch(`${clone.apiRoot}/bot${encodeURIComponent(testBotToken)}/sendMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      expect(response.status).toBe(200);

      const calls = clone.getBotCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('sendMessage');

      const replyMarkup = calls[0]?.payload.reply_markup as { inline_keyboard?: unknown };
      expect(Array.isArray(replyMarkup.inline_keyboard)).toBe(true);

      const button = (replyMarkup.inline_keyboard as Array<Array<{ callback_data?: string }>>)[0]?.[0];
      expect(button?.callback_data).toBe('m:providers:0');
    } finally {
      await clone.stop();
    }
  });
});

async function apiCall<T>(clone: TelegramBotApiClone, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${clone.apiRoot}/bot${encodeURIComponent(testBotToken)}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(200);

  const body = (await response.json()) as {
    ok: boolean;
    result: T;
  };

  expect(body.ok).toBe(true);
  return body.result;
}
