import { describe, expect, test } from 'vitest';

import type { OAuthLoginAttemptSnapshot, ProviderAuthStatus, ProviderCatalogEntry } from '../src/runtime/pi-auth.js';
import type { TelegramCloneBotCall } from './helpers/telegram-bot-api-clone.js';
import {
  createThreadRuntimeState,
  FakeThreadControlService,
  type TelegramAdapterAuthService,
  telegramTestChatId as testChatId,
  telegramTestUserId as testUserId,
  withTelegramAdapter,
} from './helpers/telegram-test-kit.js';

class FakeAuthService {
  readonly submitCalls: Array<{
    attemptId: string;
    ownerKey: string;
    value: string;
    expectedKind?: 'prompt' | 'manual_code';
  }> = [];

  failNextSubmitWithStateConflict = false;
  private readonly attempts = new Map<string, OAuthLoginAttemptSnapshot>();

  constructor(
    private readonly providerStatuses: ProviderAuthStatus[] = [
      {
        provider: 'openai-codex',
        has_auth: false,
        credential_type: null,
        oauth_supported: true,
        env_var_hint: null,
        total_models: 1,
        available_models: 0,
      },
    ],
  ) {}

  getProviderCatalog(): ProviderCatalogEntry[] {
    return [];
  }

  getProviderStatuses(): ProviderAuthStatus[] {
    return this.providerStatuses;
  }

  startOAuthLogin(provider: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    const attempt: OAuthLoginAttemptSnapshot = {
      attempt_id: 'attempt-1',
      owner_key: ownerKey,
      provider,
      provider_name: 'OpenAI Codex',
      status: 'awaiting_input',
      auth: {
        url: 'https://example.com/auth',
        instructions: 'Complete login in browser.',
      },
      prompt: {
        kind: 'manual_code',
        message: 'Paste authorization code',
        placeholder: null,
        allow_empty: false,
      },
      progress_messages: ['Waiting for callback...'],
      error: null,
    };

    this.attempts.set(attempt.attempt_id, attempt);
    return attempt;
  }

  getOAuthLoginAttempt(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.owner_key !== ownerKey) {
      return null;
    }

    return attempt;
  }

  markAttemptSucceeded(attemptId: string): void {
    const current = this.attempts.get(attemptId);
    if (!current) {
      return;
    }

    this.attempts.set(attemptId, {
      ...current,
      status: 'succeeded',
      prompt: null,
      progress_messages: [...current.progress_messages, 'OAuth login completed'],
    });
  }

  submitOAuthLoginInput(
    attemptId: string,
    ownerKey: string,
    value: string,
    expectedKind?: 'prompt' | 'manual_code',
  ): OAuthLoginAttemptSnapshot {
    this.submitCalls.push({ attemptId, ownerKey, value, expectedKind });

    const current = this.attempts.get(attemptId);
    if (!current || current.owner_key !== ownerKey) {
      throw new Error('attempt not found');
    }

    if (this.failNextSubmitWithStateConflict) {
      this.failNextSubmitWithStateConflict = false;
      this.markAttemptSucceeded(attemptId);
      throw new Error('OAuth login attempt is not waiting for input');
    }

    const updated: OAuthLoginAttemptSnapshot = {
      ...current,
      status: 'succeeded',
      prompt: null,
      progress_messages: [...current.progress_messages, 'OAuth login completed'],
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }

  cancelOAuthLogin(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    const current = this.attempts.get(attemptId);
    if (!current || current.owner_key !== ownerKey) {
      throw new Error('attempt not found');
    }

    const updated: OAuthLoginAttemptSnapshot = {
      ...current,
      status: 'cancelled',
      prompt: null,
      error: 'OAuth login cancelled',
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }
}

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

function createCatalogAuthService(
  providerCatalog: ProviderCatalogEntry[],
  providerStatuses: ProviderAuthStatus[] = [],
): TelegramAdapterAuthService {
  return {
    getProviderCatalog: () => providerCatalog,
    getProviderStatuses: () => providerStatuses,
    startOAuthLogin: () => notUsed('startOAuthLogin'),
    getOAuthLoginAttempt: () => null,
    submitOAuthLoginInput: () => notUsed('submitOAuthLoginInput'),
    cancelOAuthLogin: () => notUsed('cancelOAuthLogin'),
  };
}

function notUsed(name: string): never {
  throw new Error(`${name} not used in this test`);
}

function createProviderCatalog(count: number): ProviderCatalogEntry[] {
  return Array.from({ length: count }, (_, index) => createProvider(`provider-${index}`, [`model-${index}`]));
}

function createProvider(provider: string, modelIds: string[]): ProviderCatalogEntry {
  return {
    provider,
    has_auth: true,
    credential_type: 'api_key',
    oauth_supported: false,
    env_var_hint: null,
    total_models: modelIds.length,
    available_models: modelIds.length,
    models: modelIds.map((modelId) => ({
      provider,
      model_id: modelId,
      name: modelId,
      reasoning: false,
      available: true,
    })),
  };
}

function textOf(call: TelegramCloneBotCall): string {
  const text = call.payload.text;
  if (typeof text === 'string') {
    return text;
  }

  return '';
}

function allCallbackData(call: TelegramCloneBotCall): string[] {
  const replyMarkup = call.payload.reply_markup;
  if (!replyMarkup || typeof replyMarkup !== 'object') {
    return [];
  }

  const inlineKeyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) {
    return [];
  }

  const callbackData: string[] = [];

  for (const row of inlineKeyboard) {
    if (!Array.isArray(row)) {
      continue;
    }

    for (const button of row) {
      if (!button || typeof button !== 'object') {
        continue;
      }

      const value = (button as { callback_data?: unknown }).callback_data;
      if (typeof value === 'string') {
        callbackData.push(value);
      }
    }
  }

  return callbackData;
}
