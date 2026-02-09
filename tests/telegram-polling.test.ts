import { describe, expect, test } from 'vitest';

import { parseTelegramCallbackData } from '../src/adapters/telegram-controls-callbacks.js';
import { parseTelegramCommand } from '../src/adapters/telegram-polling.js';
import {
  createThreadRuntimeState,
  FakeThreadControlService,
  telegramTestChatId,
  telegramTestUserId,
  withTelegramAdapter,
} from './helpers/telegram-test-kit.js';

describe('parseTelegramCommand', () => {
  test('parses command with args', () => {
    expect(parseTelegramCommand('/steer interrupt current run')).toEqual({
      command: 'steer',
      args: 'interrupt current run',
    });
  });

  test('parses command addressed to bot username', () => {
    expect(parseTelegramCommand('/thinking@jagc_bot')).toEqual({
      command: 'thinking',
      args: '',
    });
  });

  test('returns null for plain text', () => {
    expect(parseTelegramCommand('hello there')).toBeNull();
  });
});

describe('parseTelegramCallbackData', () => {
  test('parses settings actions', () => {
    expect(parseTelegramCallbackData('s:open')).toEqual({ kind: 'settings_open' });
    expect(parseTelegramCallbackData('s:refresh')).toBeNull();
  });

  test('parses auth picker actions', () => {
    expect(parseTelegramCallbackData('a:open')).toEqual({ kind: 'auth_open' });
    expect(parseTelegramCallbackData('a:providers:1')).toEqual({ kind: 'auth_providers', page: 1 });
    expect(parseTelegramCallbackData('a:login:openai-codex')).toEqual({ kind: 'auth_login', provider: 'openai-codex' });
    expect(parseTelegramCallbackData('a:attempt:refresh:abc-123')).toEqual({
      kind: 'auth_attempt_refresh',
      attemptId: 'abc-123',
    });
    expect(parseTelegramCallbackData('a:attempt:cancel:abc-123')).toEqual({
      kind: 'auth_attempt_cancel',
      attemptId: 'abc-123',
    });
  });

  test('parses model picker actions', () => {
    expect(parseTelegramCallbackData('m:providers:2')).toEqual({ kind: 'model_providers', page: 2 });
    expect(parseTelegramCallbackData('m:list:openai:0')).toEqual({ kind: 'model_list', provider: 'openai', page: 0 });
    expect(parseTelegramCallbackData('m:set:vercel-ai-gateway:gpt-5')).toEqual({
      kind: 'model_set',
      provider: 'vercel-ai-gateway',
      modelId: 'gpt-5',
    });
    expect(parseTelegramCallbackData('m:set:openrouter:deepseek%2Fdeepseek-r1')).toEqual({
      kind: 'model_set',
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-r1',
    });
  });

  test('parses thinking picker actions', () => {
    expect(parseTelegramCallbackData('t:list')).toEqual({ kind: 'thinking_list' });
    expect(parseTelegramCallbackData('t:set:high')).toEqual({ kind: 'thinking_set', thinkingLevel: 'high' });
    expect(parseTelegramCallbackData('t:set:ultra')).toEqual({ kind: 'thinking_set', thinkingLevel: 'ultra' });
  });

  test('returns null for invalid data', () => {
    expect(parseTelegramCallbackData('m:providers:-1')).toBeNull();
    expect(parseTelegramCallbackData('m:list::0')).toBeNull();
    expect(parseTelegramCallbackData('m:set:openai::0')).toBeNull();
    expect(parseTelegramCallbackData('m:set:openai:gpt-5:0')).toBeNull();
    expect(parseTelegramCallbackData('unknown')).toBeNull();
  });
});

describe('TelegramPollingAdapter commands', () => {
  test('/new resets thread session and confirms next message starts fresh', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: telegramTestChatId,
        fromId: telegramTestUserId,
        text: '/new',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('✅ Session reset. Your next message will start a new pi session.');
      expect(threadControlService.resetCalls).toEqual(['telegram:chat:101']);
    });
  });
});

describe('TelegramPollingAdapter callback recovery', () => {
  test('invalid callback data recovers to the latest settings panel', async () => {
    await withTelegramAdapter(
      { threadControlService: new FakeThreadControlService(createThreadRuntimeState()) },
      async ({ clone }) => {
        clone.injectCallbackQuery({
          chatId: telegramTestChatId,
          fromId: telegramTestUserId,
          data: 's:refresh',
        });

        const callbackAnswer = await clone.waitForBotCall('answerCallbackQuery');
        expect(callbackAnswer.payload.text).toMatch(/outdated/i);

        const editMessage = await clone.waitForBotCall('editMessageText');
        expect(editMessage.payload.text).toEqual(expect.stringContaining('⚙️ Runtime settings'));
        expect(editMessage.payload.text).toEqual(
          expect.stringContaining('This menu is outdated. Showing latest settings.'),
        );
      },
    );
  });
});
