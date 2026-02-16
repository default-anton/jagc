import { describe, expect, test } from 'vitest';

import { parseTelegramCallbackData } from '../src/adapters/telegram-controls-callbacks.js';
import { parseTelegramCommand } from '../src/adapters/telegram-polling.js';
import { formatTaskTopicTitle } from '../src/adapters/telegram-polling-helpers.js';
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

describe('formatTaskTopicTitle', () => {
  test('uses only the task title for Telegram topic names', () => {
    expect(formatTaskTopicTitle('task-123', '  Brush your teeth  ')).toBe('Brush your teeth');
  });

  test('falls back to task when title is empty', () => {
    expect(formatTaskTopicTitle('task-123', '   ')).toBe('task');
  });

  test('truncates long titles to Telegram topic title limits', () => {
    const title = 'a'.repeat(140);
    expect(formatTaskTopicTitle('task-123', title)).toHaveLength(128);
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
  test('/cancel aborts active thread run without resetting session', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: telegramTestChatId,
        fromId: telegramTestUserId,
        text: '/cancel',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('🛑 Stopped the active run. Session context is preserved.');
      expect(threadControlService.cancelCalls).toEqual(['telegram:chat:101']);
      expect(threadControlService.resetCalls).toEqual([]);
    });
  });

  test('/cancel in topic thread targets the topic-scoped thread key', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: telegramTestChatId,
        fromId: telegramTestUserId,
        text: '/cancel',
        messageThreadId: 333,
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('🛑 Stopped the active run. Session context is preserved.');
      expect(threadControlService.cancelCalls).toEqual(['telegram:chat:101:topic:333']);
    });
  });

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

  test('/delete removes the current topic, clears scheduled-task execution mapping, and resets that topic session', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const clearedThreadKeys: string[] = [];

    await withTelegramAdapter(
      {
        threadControlService,
        clearScheduledTaskExecutionThreadByKey: async (threadKey) => {
          clearedThreadKeys.push(threadKey);
          return 1;
        },
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: telegramTestChatId,
          fromId: telegramTestUserId,
          text: '/delete',
          messageThreadId: 333,
        });

        const deleteTopic = await clone.waitForBotCall('deleteForumTopic');
        expect(deleteTopic.payload).toMatchObject({
          chat_id: telegramTestChatId,
          message_thread_id: 333,
        });

        await expect.poll(() => clearedThreadKeys).toEqual(['telegram:chat:101:topic:333']);
        await expect.poll(() => threadControlService.resetCalls).toEqual(['telegram:chat:101:topic:333']);
      },
    );
  });

  test('/delete outside a topic thread returns guidance and does not call Telegram delete', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: telegramTestChatId,
        fromId: telegramTestUserId,
        text: '/delete',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('This command only works inside a Telegram topic thread.');

      expect(clone.getBotCalls().some((call) => call.method === 'deleteForumTopic')).toBe(false);
    });
  });

  test('/delete maps missing-topic Telegram errors to telegram_topic_not_found', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const clearedThreadKeys: string[] = [];

    await withTelegramAdapter(
      {
        threadControlService,
        clearScheduledTaskExecutionThreadByKey: async (threadKey) => {
          clearedThreadKeys.push(threadKey);
          return 1;
        },
      },
      async ({ clone }) => {
        clone.failNextApiCall('deleteForumTopic', {
          errorCode: 400,
          description: 'Bad Request: message thread not found',
        });

        clone.injectTextMessage({
          chatId: telegramTestChatId,
          fromId: telegramTestUserId,
          text: '/delete',
          messageThreadId: 333,
        });

        const sendMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) =>
            typeof call.payload.text === 'string' &&
            String(call.payload.text).includes(
              'telegram_topic_not_found: this topic no longer exists or is already deleted.',
            ),
        );

        expect(sendMessage.payload.text).toContain(
          'telegram_topic_not_found: this topic no longer exists or is already deleted.',
        );
        expect(clearedThreadKeys).toEqual([]);
        expect(threadControlService.resetCalls).toEqual([]);
      },
    );
  });

  test('/delete maps disabled-topic Telegram errors to telegram_topics_unavailable', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter(
      {
        hasTopicsEnabled: false,
        threadControlService,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: telegramTestChatId,
          fromId: telegramTestUserId,
          text: '/delete',
          messageThreadId: 333,
        });

        const sendMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) =>
            typeof call.payload.text === 'string' && String(call.payload.text).includes('telegram_topics_unavailable:'),
        );

        expect(sendMessage.payload.text).toContain(
          'telegram_topics_unavailable: this chat has no topic mode enabled for the bot; enable private topics in BotFather and retry',
        );
        expect(threadControlService.resetCalls).toEqual([]);
      },
    );
  });

  test('/help includes /delete command', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: telegramTestChatId,
        fromId: telegramTestUserId,
        text: '/help',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toContain('/delete — delete the current Telegram topic thread');
    });
  });
});

describe('TelegramPollingAdapter task topic creation', () => {
  test('returns actionable error when private topics are disabled', async () => {
    await withTelegramAdapter({ hasTopicsEnabled: false }, async ({ adapter }) => {
      await expect(
        adapter.createTaskTopic({
          chatId: telegramTestChatId,
          taskId: 'task-1',
          title: 'Disabled topics',
        }),
      ).rejects.toThrow(/telegram_topics_unavailable/u);
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
