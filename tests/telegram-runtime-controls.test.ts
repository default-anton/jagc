import { describe, expect, test } from 'vitest';

import {
  allCallbackData,
  createCatalogAuthService,
  createProvider,
  createProviderCatalog,
  FakeAuthService,
  textOf,
} from './helpers/telegram-runtime-controls-test-kit.js';
import {
  createThreadRuntimeState,
  FakeThreadControlService,
  telegramTestChatId as testChatId,
  telegramTestUserId as testUserId,
  withTelegramAdapter,
} from './helpers/telegram-test-kit.js';

describe('Telegram runtime controls integration', () => {
  test('clamps out-of-range provider pages', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = createCatalogAuthService(createProviderCatalog(9));

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:providers:99',
      });

      const editMessage = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('Choose provider (2/2):'),
      );

      const callbackData = allCallbackData(editMessage);
      expect(callbackData).toContain('m:providers:0');
      expect(callbackData).not.toContain('m:providers:2');
    });
  });

  test('model selection callback uses model ids and handles stale options', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = createCatalogAuthService([createProvider('openrouter', ['deepseek/deepseek-r1'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:list:openrouter:0',
      });

      const picker = await clone.waitForBotCall('editMessageText', (call) => textOf(call).includes('Choose model'));
      const pickerCallbackData = allCallbackData(picker);
      expect(pickerCallbackData).toContain('m:set:openrouter:deepseek%2Fdeepseek-r1');

      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:set:openrouter:missing-model',
      });

      const stale = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('Model option expired. Reopen /model and try again.'),
      );
      expect(textOf(stale)).toContain('Model option expired. Reopen /model and try again.');
    });
  });

  test('model set returns to settings panel with updated state', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = createCatalogAuthService([createProvider('openrouter', ['deepseek/deepseek-r1'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:set:openrouter:deepseek%2Fdeepseek-r1',
      });

      const editMessage = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('✅ Model set to openrouter/deepseek/deepseek-r1'),
      );

      expect(threadControlService.modelSetCalls).toEqual([
        {
          threadKey: 'telegram:chat:101',
          provider: 'openrouter',
          modelId: 'deepseek/deepseek-r1',
        },
      ]);

      const messageText = textOf(editMessage);
      expect(messageText).toContain('⚙️ Runtime settings');
      expect(messageText).toContain('Model: openrouter/deepseek/deepseek-r1');

      const callbackData = allCallbackData(editMessage);
      expect(callbackData).toContain('m:providers:0');
      expect(callbackData).toContain('t:list');
      expect(callbackData).toContain('a:providers:0');
      expect(callbackData).not.toContain('s:refresh');
    });
  });

  test('model set callback in topic thread uses topic-scoped thread key', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = createCatalogAuthService([createProvider('openrouter', ['deepseek/deepseek-r1'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:set:openrouter:deepseek%2Fdeepseek-r1',
        messageThreadId: 333,
      });

      await clone.waitForBotCall('editMessageText', (call) => textOf(call).includes('✅ Model set'), 4_000);

      expect(threadControlService.modelSetCalls).toEqual([
        {
          threadKey: 'telegram:chat:101:topic:333',
          provider: 'openrouter',
          modelId: 'deepseek/deepseek-r1',
        },
      ]);
    });
  });

  test('hides model options that exceed Telegram callback size limit', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = createCatalogAuthService([
      createProvider('openrouter', [
        'short-model',
        'this/is-a-very-very-very-very-very-very-very-long-model-identifier-that-overflows-callback-limit',
      ]),
    ]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'm:list:openrouter:0',
      });

      const editMessage = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('hidden due to Telegram callback limit (64 bytes)'),
      );

      const callbackData = allCallbackData(editMessage);
      expect(callbackData).toContain('m:set:openrouter:short-model');
      expect(callbackData.some((value) => value.includes('very-very-very-very-very-very-very-long-model'))).toBe(false);
    });
  });

  test('shows unavailable message when pi thread controls are not configured', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/model',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('Model controls are unavailable when JAGC_RUNNER is not pi.');
    });
  });

  test('cancel command aborts active run without resetting session', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/cancel',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('🛑 Stopped the active run. Session context is preserved.');
      expect(threadControlService.cancelCalls).toEqual(['telegram:chat:101']);
      expect(threadControlService.resetCalls).toHaveLength(0);
    });
  });

  test('cancel command reports when no active run is present', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    threadControlService.cancelResult = false;

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/cancel',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('No active run to stop in this chat. Session context is preserved.');
      expect(threadControlService.cancelCalls).toEqual(['telegram:chat:101']);
    });
  });

  test('cancel command reports unavailable when pi thread controls are not configured', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/cancel',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('Run cancellation is unavailable when JAGC_RUNNER is not pi.');
    });
  });

  test('new command resets thread session', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/new',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('✅ Session reset. Your next message will start a new pi session.');
      expect(threadControlService.resetCalls).toEqual(['telegram:chat:101']);
    });
  });

  test('new command in a topic thread resets only that topic thread session', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/new',
        messageThreadId: 333,
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('✅ Session reset. Your next message will start a new pi session.');
      expect(threadControlService.resetCalls).toEqual(['telegram:chat:101:topic:333']);
    });
  });

  test('new command reports unavailable when pi thread controls are not configured', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/new',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('Session reset is unavailable when JAGC_RUNNER is not pi.');
    });
  });

  test('share command exports session and returns share links', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter({ threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/share',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toContain('Share URL: https://pi.dev/session/#telegram%3Achat%3A101');
      expect(sendMessage.payload.text).toContain('Gist: https://gist.github.com/test/telegram%3Achat%3A101');
      expect(threadControlService.shareCalls).toEqual(['telegram:chat:101']);
    });
  });

  test('share command reports unavailable when pi thread controls are not configured', async () => {
    await withTelegramAdapter({}, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/share',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage');
      expect(sendMessage.payload.text).toBe('Session sharing is unavailable when JAGC_RUNNER is not pi.');
    });
  });

  test('settings keyboard omits refresh button', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService();

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/settings',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('⚙️ Runtime settings'),
      );
      const callbackData = allCallbackData(sendMessage);

      expect(callbackData).toContain('m:providers:0');
      expect(callbackData).toContain('t:list');
      expect(callbackData).toContain('a:providers:0');
      expect(callbackData).not.toContain('s:refresh');
    });
  });

  test('auth command opens oauth provider picker', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService();

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/auth',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) => textOf(call).includes('Provider login'));
      const callbackData = allCallbackData(sendMessage);

      expect(callbackData).toContain('a:login:openai-codex');
    });
  });

  test('auth provider picker hides providers that exceed callback size limit', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService([
      {
        provider:
          'this-provider-name-is-unreasonably-long-and-exceeds-the-telegram-callback-data-limit-for-login-actions',
        has_auth: false,
        credential_type: null,
        oauth_supported: true,
        env_var_hint: null,
        total_models: 1,
        available_models: 1,
      },
    ]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/auth',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('hidden due to Telegram callback limit (64 bytes)'),
      );

      const callbackData = allCallbackData(sendMessage);
      expect(callbackData).not.toContain(
        'a:login:this-provider-name-is-unreasonably-long-and-exceeds-the-telegram-callback-data-limit-for-login-actions',
      );
      expect(callbackData).toContain('s:open');
    });
  });

  test('auth input command submits pending oauth code', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService();

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'a:login:openai-codex',
      });

      await clone.waitForBotCall('editMessageText', (call) => textOf(call).includes('Status: Waiting for input'));

      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/auth input https://example/callback?code=abc',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('Status: Succeeded'),
      );

      expect(authService.submitCalls).toHaveLength(1);
      expect(authService.submitCalls[0]).toMatchObject({
        attemptId: 'attempt-1',
        expectedKind: 'manual_code',
      });
      expect(textOf(sendMessage)).toContain('Status: Succeeded');
    });
  });

  test('auth input reports browser-completed login without failing', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService();

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'a:login:openai-codex',
      });

      await clone.waitForBotCall('editMessageText', (call) => textOf(call).includes('Status: Waiting for input'));
      authService.markAttemptSucceeded('attempt-1');

      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/auth input https://example/callback?code=abc',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('OAuth login already completed in browser.'),
      );

      expect(authService.submitCalls).toHaveLength(0);
      expect(textOf(sendMessage)).toContain('Status: Succeeded');
    });
  });

  test('auth input race after typing resolves to succeeded attempt', async () => {
    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());
    const authService = new FakeAuthService();
    authService.failNextSubmitWithStateConflict = true;

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 'a:login:openai-codex',
      });

      await clone.waitForBotCall('editMessageText', (call) => textOf(call).includes('Status: Waiting for input'));

      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/auth input https://example/callback?code=abc',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('OAuth login already completed in browser.'),
      );

      expect(authService.submitCalls).toHaveLength(1);
      expect(textOf(sendMessage)).toContain('Status: Succeeded');
    });
  });

  test('shows unsupported-thinking message when current model does not support thinking', async () => {
    const threadControlService = new FakeThreadControlService(
      createThreadRuntimeState({
        supportsThinking: false,
        availableThinkingLevels: [],
      }),
    );

    const authService = createCatalogAuthService([createProvider('openai', ['gpt-5'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/thinking',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) =>
        textOf(call).includes('does not support configurable thinking levels'),
      );

      const callbackData = allCallbackData(sendMessage);
      expect(callbackData).toContain('m:providers:0');
      expect(callbackData).toContain('s:open');
    });
  });

  test('thinking set returns to settings panel with updated state', async () => {
    const threadControlService = new FakeThreadControlService(
      createThreadRuntimeState({
        availableThinkingLevels: ['off', 'low', 'medium', 'high'],
        thinkingLevel: 'medium',
      }),
    );

    const authService = createCatalogAuthService([createProvider('openai', ['gpt-5'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 't:set:high',
      });

      const editMessage = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('✅ Thinking set to high'),
      );
      expect(threadControlService.thinkingSetCalls).toEqual([
        {
          threadKey: 'telegram:chat:101',
          thinkingLevel: 'high',
        },
      ]);

      const messageText = textOf(editMessage);
      expect(messageText).toContain('⚙️ Runtime settings');
      expect(messageText).toContain('Thinking: high');

      const callbackData = allCallbackData(editMessage);
      expect(callbackData).toContain('m:providers:0');
      expect(callbackData).toContain('t:list');
      expect(callbackData).toContain('a:providers:0');
      expect(callbackData).not.toContain('s:refresh');
    });
  });

  test('rejects stale thinking callbacks not present in runtime state', async () => {
    const threadControlService = new FakeThreadControlService(
      createThreadRuntimeState({
        availableThinkingLevels: ['off', 'low', 'medium'],
        thinkingLevel: 'medium',
      }),
    );

    const authService = createCatalogAuthService([createProvider('openai', ['gpt-5'])]);

    await withTelegramAdapter({ authService, threadControlService }, async ({ clone }) => {
      clone.injectCallbackQuery({
        chatId: testChatId,
        fromId: testUserId,
        data: 't:set:ultra',
      });

      const editMessage = await clone.waitForBotCall('editMessageText', (call) =>
        textOf(call).includes('Thinking option expired. Reopen /thinking and try again.'),
      );

      expect(textOf(editMessage)).toContain('Thinking option expired. Reopen /thinking and try again.');
      expect(threadControlService.thinkingSetCalls).toHaveLength(0);
    });
  });
});
