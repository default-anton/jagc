import { createUpdateFetcher } from '@grammyjs/runner';
import { Bot } from 'grammy';
import { describe, expect, test } from 'vitest';

import { TelegramBotApiClone } from './helpers/telegram-bot-api-clone.js';
import { telegramTestBotToken as testBotToken } from './helpers/telegram-test-kit.js';

describe('TelegramBotApiClone', () => {
  test('retries transient getUpdates 500 errors and still returns updates', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      clone.failNextApiCall('getUpdates', {
        errorCode: 500,
        description: 'Internal Server Error',
      });

      clone.injectTextMessage({
        chatId: 1,
        fromId: 2,
        text: 'retry me',
      });

      const updates = await fetchWithRunner(clone, {
        allowedUpdates: ['message'],
      });

      expect(updates).toHaveLength(1);
      expect(updates[0]?.update_id).toBeTypeOf('number');
      expect(clone.getApiCallCount('getUpdates')).toBeGreaterThanOrEqual(2);
    } finally {
      await clone.stop();
    }
  });

  test('retries getUpdates 429 errors with retry_after delay', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      clone.failNextApiCall('getUpdates', {
        errorCode: 429,
        description: 'Too Many Requests: retry later',
        parameters: {
          retry_after: 0.05,
        },
      });

      clone.injectTextMessage({
        chatId: 1,
        fromId: 2,
        text: 'rate limit me',
      });

      const startedAt = Date.now();
      const updates = await fetchWithRunner(clone, {
        allowedUpdates: ['message'],
      });
      const elapsedMs = Date.now() - startedAt;

      expect(updates).toHaveLength(1);
      expect(elapsedMs).toBeGreaterThanOrEqual(45);
      expect(clone.getApiCallCount('getUpdates')).toBeGreaterThanOrEqual(2);
    } finally {
      await clone.stop();
    }
  });

  test('advances offsets correctly across mixed update types', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      clone.injectCallbackQuery({
        chatId: 1,
        fromId: 2,
        data: 'm:list:openai:0',
      }); // update_id: 1
      clone.injectTextMessage({
        chatId: 1,
        fromId: 2,
        text: 'first message',
      }); // update_id: 2
      clone.injectCallbackQuery({
        chatId: 1,
        fromId: 2,
        data: 'm:list:openai:1',
      }); // update_id: 3
      clone.injectTextMessage({
        chatId: 1,
        fromId: 2,
        text: 'second message',
      }); // update_id: 4

      const firstBatch = await apiCall<Array<Record<string, unknown>>>(clone, 'getUpdates', {
        allowed_updates: ['message'],
        limit: 1,
        timeout: 0,
      });

      expect(firstBatch).toHaveLength(1);
      expect(firstBatch[0]?.update_id).toBe(2);

      const secondBatch = await apiCall<Array<Record<string, unknown>>>(clone, 'getUpdates', {
        allowed_updates: ['message'],
        offset: 3,
        timeout: 0,
      });

      expect(secondBatch).toHaveLength(1);
      expect(secondBatch[0]?.update_id).toBe(4);

      const drained = await apiCall<Array<Record<string, unknown>>>(clone, 'getUpdates', {
        allowed_updates: ['message'],
        offset: 5,
        timeout: 0,
      });

      expect(drained).toEqual([]);
    } finally {
      await clone.stop();
    }
  });

  test('returns 400 for invalid JSON payloads and remains usable', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      const malformed = await rawApiCall(clone, 'sendMessage', '{"chat_id":101,', {
        'content-type': 'application/json',
      });

      expect(malformed.response.status).toBe(400);
      expect(malformed.body).toMatchObject({
        ok: false,
        error_code: 400,
      });

      const valid = await apiCall<Record<string, unknown>>(clone, 'sendMessage', {
        chat_id: 101,
        text: 'still alive',
      });

      expect(valid.text).toBe('still alive');
      expect(clone.getBotCalls()).toHaveLength(1);
    } finally {
      await clone.stop();
    }
  });

  test('fails loud on invalid getUpdates payload shapes', async () => {
    const clone = new TelegramBotApiClone({ token: testBotToken });
    await clone.start();

    try {
      const invalidTimeout = await apiCallExpectingError(clone, 'getUpdates', {
        timeout: 'soon',
      });
      expect(invalidTimeout.response.status).toBe(400);
      expect(invalidTimeout.body.description).toContain('getUpdates.timeout must be a non-negative number');

      const invalidAllowedUpdates = await apiCallExpectingError(clone, 'getUpdates', {
        allowed_updates: 'message',
      });
      expect(invalidAllowedUpdates.response.status).toBe(400);
      expect(invalidAllowedUpdates.body.description).toContain(
        'getUpdates.allowed_updates must be an array of strings',
      );

      const valid = await apiCall<Array<Record<string, unknown>>>(clone, 'getUpdates', {
        timeout: 0,
      });
      expect(valid).toEqual([]);
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

async function fetchWithRunner(
  clone: TelegramBotApiClone,
  options: {
    allowedUpdates?: Array<'message' | 'callback_query'>;
  } = {},
): Promise<Array<{ update_id?: number }>> {
  const bot = new Bot(testBotToken, {
    client: {
      apiRoot: clone.apiRoot ?? undefined,
    },
  });

  const fetchUpdates = createUpdateFetcher(bot, {
    fetch: {
      timeout: 0,
      allowed_updates: options.allowedUpdates,
    },
    retryInterval: 10,
    maxRetryTime: 5_000,
    silent: true,
  });

  const signal = new AbortController().signal as unknown as Parameters<typeof fetchUpdates>[1];
  const updates = await fetchUpdates(10, signal);
  return updates as Array<{ update_id?: number }>;
}

async function apiCall<T>(clone: TelegramBotApiClone, method: string, payload: Record<string, unknown>): Promise<T> {
  const { response, body } = await rawApiCall(clone, method, JSON.stringify(payload), {
    'content-type': 'application/json',
  });

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);

  return body.result as T;
}

async function apiCallExpectingError(
  clone: TelegramBotApiClone,
  method: string,
  payload: Record<string, unknown>,
): Promise<{
  response: Response;
  body: { ok: false; error_code: number; description: string };
}> {
  const { response, body } = await rawApiCall(clone, method, JSON.stringify(payload), {
    'content-type': 'application/json',
  });

  expect(body.ok).toBe(false);

  return {
    response,
    body: body as { ok: false; error_code: number; description: string },
  };
}

async function rawApiCall(
  clone: TelegramBotApiClone,
  method: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${clone.apiRoot}/bot${encodeURIComponent(testBotToken)}/${method}`, {
    method: 'POST',
    headers,
    body,
  });

  const json = (await response.json()) as Record<string, unknown>;

  return {
    response,
    body: json,
  };
}
