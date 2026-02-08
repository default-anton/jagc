import type { Context } from 'grammy';
import { describe, expect, test } from 'vitest';
import { TelegramRuntimeControls } from '../src/adapters/telegram-runtime-controls.js';
import type { OAuthLoginAttemptSnapshot, ProviderAuthStatus, ProviderCatalogEntry } from '../src/runtime/pi-auth.js';
import type { ThreadControlService, ThreadRuntimeState } from '../src/runtime/pi-executor.js';

type ThinkingLevel = ThreadRuntimeState['thinkingLevel'];

interface UiCall {
  text: string;
  options: {
    reply_markup?: {
      inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
    };
  };
}

class FakeThreadControlService implements ThreadControlService {
  readonly modelSetCalls: Array<{ threadKey: string; provider: string; modelId: string }> = [];
  readonly thinkingSetCalls: Array<{ threadKey: string; thinkingLevel: ThinkingLevel }> = [];

  constructor(private state: ThreadRuntimeState) {}

  async getThreadRuntimeState(): Promise<ThreadRuntimeState> {
    return this.state;
  }

  async setThreadModel(threadKey: string, provider: string, modelId: string): Promise<ThreadRuntimeState> {
    this.modelSetCalls.push({ threadKey, provider, modelId });
    this.state = {
      ...this.state,
      model: {
        provider,
        modelId,
        name: modelId,
      },
    };

    return this.state;
  }

  async setThreadThinkingLevel(threadKey: string, thinkingLevel: ThinkingLevel): Promise<ThreadRuntimeState> {
    this.thinkingSetCalls.push({ threadKey, thinkingLevel });
    this.state = {
      ...this.state,
      thinkingLevel,
    };

    return this.state;
  }
}

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

describe('TelegramRuntimeControls', () => {
  test('clamps out-of-range provider pages', async () => {
    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => createProviderCatalog(9),
      },
      threadControlService: new FakeThreadControlService(createState()),
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleCallbackAction(ctx, { kind: 'model_providers', page: 99 });

    expect(lastText(edits)).toContain('Choose provider (2/2):');

    const callbackData = allCallbackData(lastCall(edits));
    expect(callbackData).toContain('m:providers:0');
    expect(callbackData).not.toContain('m:providers:2');
  });

  test('model selection callback uses model ids and handles stale options', async () => {
    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [createProvider('openrouter', ['deepseek/deepseek-r1'])],
      },
      threadControlService: new FakeThreadControlService(createState()),
    });

    const pickerContext = createContext({ callback: true });
    await controls.handleCallbackAction(pickerContext.ctx, {
      kind: 'model_list',
      provider: 'openrouter',
      page: 0,
    });

    const pickerCallbackData = allCallbackData(lastCall(pickerContext.edits));
    expect(pickerCallbackData).toContain('m:set:openrouter:deepseek%2Fdeepseek-r1');

    const staleContext = createContext({ callback: true });
    await controls.handleCallbackAction(staleContext.ctx, {
      kind: 'model_set',
      provider: 'openrouter',
      modelId: 'missing-model',
    });

    expect(lastText(staleContext.edits)).toContain('Model option expired. Reopen /model and try again.');
  });

  test('model set returns to settings panel with updated state', async () => {
    const threadControlService = new FakeThreadControlService(createState());
    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [createProvider('openrouter', ['deepseek/deepseek-r1'])],
      },
      threadControlService,
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleCallbackAction(ctx, {
      kind: 'model_set',
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-r1',
    });

    expect(threadControlService.modelSetCalls).toEqual([
      {
        threadKey: 'telegram:chat:101',
        provider: 'openrouter',
        modelId: 'deepseek/deepseek-r1',
      },
    ]);

    const lastEdit = lastCall(edits);
    expect(lastEdit.text).toContain('✅ Model set to openrouter/deepseek/deepseek-r1');
    expect(lastEdit.text).toContain('⚙️ Runtime settings');
    expect(lastEdit.text).toContain('Model: openrouter/deepseek/deepseek-r1');

    const callbackData = allCallbackData(lastEdit);
    expect(callbackData).toContain('m:providers:0');
    expect(callbackData).toContain('t:list');
    expect(callbackData).toContain('a:providers:0');
    expect(callbackData).not.toContain('s:refresh');
  });

  test('hides model options that exceed Telegram callback size limit', async () => {
    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [
          createProvider('openrouter', [
            'short-model',
            'this/is-a-very-very-very-very-very-very-very-long-model-identifier-that-overflows-callback-limit',
          ]),
        ],
      },
      threadControlService: new FakeThreadControlService(createState()),
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleCallbackAction(ctx, {
      kind: 'model_list',
      provider: 'openrouter',
      page: 0,
    });

    const lastEdit = lastCall(edits);
    expect(lastEdit.text).toContain('hidden due to Telegram callback limit (64 bytes)');

    const callbackData = allCallbackData(lastEdit);
    expect(callbackData).toContain('m:set:openrouter:short-model');
    expect(callbackData.some((value) => value.includes('very-very-very-very-very-very-very-long-model'))).toBe(false);
  });

  test('shows stale-callback recovery notice with latest settings', async () => {
    const controls = new TelegramRuntimeControls({
      threadControlService: new FakeThreadControlService(createState()),
      authService: new FakeAuthService(),
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleStaleCallback(ctx);

    const lastEdit = lastCall(edits);
    expect(lastEdit.text).toContain('This menu is outdated. Showing latest settings.');
    expect(lastEdit.text).toContain('⚙️ Runtime settings');
  });

  test('shows unavailable message when pi thread controls are not configured', async () => {
    const controls = new TelegramRuntimeControls({});
    const { ctx, replies } = createContext();

    await controls.handleModelCommand(ctx, '');

    expect(lastText(replies)).toBe('Model controls are unavailable when JAGC_RUNNER is not pi.');
  });

  test('settings keyboard omits refresh button', async () => {
    const controls = new TelegramRuntimeControls({
      threadControlService: new FakeThreadControlService(createState()),
      authService: new FakeAuthService(),
    });

    const { ctx, replies } = createContext();
    await controls.handleSettingsCommand(ctx);

    const callbackData = allCallbackData(lastCall(replies));
    expect(callbackData).toContain('m:providers:0');
    expect(callbackData).toContain('t:list');
    expect(callbackData).toContain('a:providers:0');
    expect(callbackData).not.toContain('s:refresh');
  });

  test('auth command opens oauth provider picker', async () => {
    const controls = new TelegramRuntimeControls({
      authService: new FakeAuthService(),
      threadControlService: new FakeThreadControlService(createState()),
    });

    const { ctx, replies } = createContext();
    await controls.handleAuthCommand(ctx, '');

    expect(lastText(replies)).toContain('Provider login');
    const callbackData = allCallbackData(lastCall(replies));
    expect(callbackData).toContain('a:login:openai-codex');
  });

  test('auth provider picker hides providers that exceed callback size limit', async () => {
    const controls = new TelegramRuntimeControls({
      authService: new FakeAuthService([
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
      ]),
      threadControlService: new FakeThreadControlService(createState()),
    });

    const { ctx, replies } = createContext();
    await controls.handleAuthCommand(ctx, '');

    const lastReply = lastCall(replies);
    expect(lastReply.text).toContain('hidden due to Telegram callback limit (64 bytes)');

    const callbackData = allCallbackData(lastReply);
    expect(callbackData).not.toContain(
      'a:login:this-provider-name-is-unreasonably-long-and-exceeds-the-telegram-callback-data-limit-for-login-actions',
    );
    expect(callbackData).toContain('s:open');
  });

  test('auth input command submits pending oauth code', async () => {
    const authService = new FakeAuthService();
    const controls = new TelegramRuntimeControls({
      authService,
      threadControlService: new FakeThreadControlService(createState()),
    });

    const callbackContext = createContext({ callback: true });
    await controls.handleCallbackAction(callbackContext.ctx, {
      kind: 'auth_login',
      provider: 'openai-codex',
    });

    const commandContext = createContext();
    await controls.handleAuthCommand(commandContext.ctx, 'input https://example/callback?code=abc');

    expect(authService.submitCalls).toHaveLength(1);
    expect(authService.submitCalls[0]).toMatchObject({
      attemptId: 'attempt-1',
      expectedKind: 'manual_code',
    });
    expect(lastText(commandContext.replies)).toContain('Status: Succeeded');
  });

  test('auth input reports browser-completed login without failing', async () => {
    const authService = new FakeAuthService();
    const controls = new TelegramRuntimeControls({
      authService,
      threadControlService: new FakeThreadControlService(createState()),
    });

    const callbackContext = createContext({ callback: true });
    await controls.handleCallbackAction(callbackContext.ctx, {
      kind: 'auth_login',
      provider: 'openai-codex',
    });

    authService.markAttemptSucceeded('attempt-1');

    const commandContext = createContext();
    await controls.handleAuthCommand(commandContext.ctx, 'input https://example/callback?code=abc');

    expect(authService.submitCalls).toHaveLength(0);
    expect(lastText(commandContext.replies)).toContain('OAuth login already completed in browser.');
    expect(lastText(commandContext.replies)).toContain('Status: Succeeded');
  });

  test('auth input race after typing resolves to succeeded attempt', async () => {
    const authService = new FakeAuthService();
    authService.failNextSubmitWithStateConflict = true;

    const controls = new TelegramRuntimeControls({
      authService,
      threadControlService: new FakeThreadControlService(createState()),
    });

    const callbackContext = createContext({ callback: true });
    await controls.handleCallbackAction(callbackContext.ctx, {
      kind: 'auth_login',
      provider: 'openai-codex',
    });

    const commandContext = createContext();
    await controls.handleAuthCommand(commandContext.ctx, 'input https://example/callback?code=abc');

    expect(authService.submitCalls).toHaveLength(1);
    expect(lastText(commandContext.replies)).toContain('OAuth login already completed in browser.');
    expect(lastText(commandContext.replies)).toContain('Status: Succeeded');
  });

  test('shows unsupported-thinking message when current model does not support thinking', async () => {
    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [createProvider('openai', ['gpt-5'])],
      },
      threadControlService: new FakeThreadControlService(
        createState({ supportsThinking: false, availableThinkingLevels: [] }),
      ),
    });

    const { ctx, replies } = createContext();

    await controls.handleThinkingCommand(ctx, '');

    expect(lastText(replies)).toContain('This model does not support configurable thinking levels.');
    const callbackData = allCallbackData(lastCall(replies));
    expect(callbackData).toContain('m:providers:0');
    expect(callbackData).toContain('s:open');
  });

  test('thinking set returns to settings panel with updated state', async () => {
    const threadControlService = new FakeThreadControlService(
      createState({ availableThinkingLevels: ['off', 'low', 'medium', 'high'], thinkingLevel: 'medium' }),
    );

    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [createProvider('openai', ['gpt-5'])],
      },
      threadControlService,
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleCallbackAction(ctx, {
      kind: 'thinking_set',
      thinkingLevel: 'high',
    });

    expect(threadControlService.thinkingSetCalls).toEqual([
      {
        threadKey: 'telegram:chat:101',
        thinkingLevel: 'high',
      },
    ]);

    const lastEdit = lastCall(edits);
    expect(lastEdit.text).toContain('✅ Thinking set to high');
    expect(lastEdit.text).toContain('⚙️ Runtime settings');
    expect(lastEdit.text).toContain('Thinking: high');

    const callbackData = allCallbackData(lastEdit);
    expect(callbackData).toContain('m:providers:0');
    expect(callbackData).toContain('t:list');
    expect(callbackData).toContain('a:providers:0');
    expect(callbackData).not.toContain('s:refresh');
  });

  test('rejects stale thinking callbacks not present in runtime state', async () => {
    const threadControlService = new FakeThreadControlService(
      createState({ availableThinkingLevels: ['off', 'low', 'medium'], thinkingLevel: 'medium' }),
    );

    const controls = new TelegramRuntimeControls({
      authService: {
        getProviderCatalog: () => [createProvider('openai', ['gpt-5'])],
      },
      threadControlService,
    });

    const { ctx, edits } = createContext({ callback: true });
    await controls.handleCallbackAction(ctx, {
      kind: 'thinking_set',
      thinkingLevel: 'ultra',
    });

    expect(lastText(edits)).toContain('Thinking option expired. Reopen /thinking and try again.');
    expect(threadControlService.thinkingSetCalls).toHaveLength(0);
  });
});

function createContext(options: { callback?: boolean } = {}): { ctx: Context; replies: UiCall[]; edits: UiCall[] } {
  const replies: UiCall[] = [];
  const edits: UiCall[] = [];

  const ctx = {
    chat: {
      id: 101,
      type: 'private',
    },
    callbackQuery: options.callback
      ? {
          data: 'irrelevant',
          message: {
            message_id: 1,
          },
        }
      : undefined,
    async reply(text: string, options: UiCall['options']) {
      replies.push({ text, options });
      return undefined;
    },
    async editMessageText(text: string, options: UiCall['options']) {
      edits.push({ text, options });
      return undefined;
    },
  };

  return {
    ctx: ctx as unknown as Context,
    replies,
    edits,
  };
}

function createState(overrides: Partial<ThreadRuntimeState> = {}): ThreadRuntimeState {
  return {
    threadKey: 'telegram:chat:101',
    model: {
      provider: 'openai',
      modelId: 'gpt-5',
      name: 'GPT-5',
    },
    thinkingLevel: 'medium',
    supportsThinking: true,
    availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    ...overrides,
  };
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

function lastCall(calls: UiCall[]): UiCall {
  const call = calls.at(-1);
  if (!call) {
    throw new Error('expected at least one UI call');
  }

  return call;
}

function lastText(calls: UiCall[]): string {
  return lastCall(calls).text;
}

function allCallbackData(call: UiCall): string[] {
  const rows = call.options.reply_markup?.inline_keyboard ?? [];
  return rows.flatMap((row) => row.map((button) => button.callback_data).filter((value): value is string => !!value));
}
