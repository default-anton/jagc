import type { Context } from 'grammy';
import { describe, expect, test } from 'vitest';
import { TelegramRuntimeControls } from '../src/adapters/telegram-runtime-controls.js';
import type { ProviderCatalogEntry } from '../src/runtime/pi-auth.js';
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
    expect(pickerCallbackData).toContain('m:set:openrouter:deepseek%2Fdeepseek-r1:0');

    const staleContext = createContext({ callback: true });
    await controls.handleCallbackAction(staleContext.ctx, {
      kind: 'model_set',
      provider: 'openrouter',
      modelId: 'missing-model',
      page: 0,
    });

    expect(lastText(staleContext.edits)).toContain('Model option expired. Reopen /model and try again.');
  });

  test('shows unavailable message when pi thread controls are not configured', async () => {
    const controls = new TelegramRuntimeControls({});
    const { ctx, replies } = createContext();

    await controls.handleModelCommand(ctx, '');

    expect(lastText(replies)).toBe('Model controls are unavailable when JAGC_RUNNER is not pi.');
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
