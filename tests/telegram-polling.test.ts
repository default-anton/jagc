import type { Context } from 'grammy';
import { describe, expect, test } from 'vitest';

import { parseTelegramCallbackData } from '../src/adapters/telegram-controls-callbacks.js';
import { parseTelegramCommand, TelegramPollingAdapter } from '../src/adapters/telegram-polling.js';
import type { ThreadControlService, ThreadRuntimeState } from '../src/runtime/pi-executor.js';
import type { RunService } from '../src/server/service.js';

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
    const threadControlService = new FakeThreadControlService(createRuntimeState());
    const adapter = new TelegramPollingAdapter({
      botToken: '123456:TESTTOKEN',
      runService: createRunServiceStub(),
      threadControlService,
    });

    const { ctx, replies } = createTextContext('/new');
    const handleTextMessage = (
      adapter as unknown as { handleTextMessage(messageContext: Context): Promise<void> }
    ).handleTextMessage.bind(adapter);
    await handleTextMessage(ctx);

    expect(threadControlService.resetCalls).toEqual(['telegram:chat:101']);
    expect(replies).toEqual([
      {
        text: '✅ Session reset. Your next message will start a new pi session.',
        options: undefined,
      },
    ]);
  });
});

describe('TelegramPollingAdapter callback recovery', () => {
  test('invalid callback data recovers to the latest settings panel', async () => {
    const adapter = new TelegramPollingAdapter({
      botToken: '123456:TESTTOKEN',
      runService: createRunServiceStub(),
      threadControlService: new FakeThreadControlService(createRuntimeState()),
    });

    const { ctx, callbackAnswers, edits } = createCallbackContext('s:refresh');
    const handleCallbackQuery = (
      adapter as unknown as { handleCallbackQuery(callbackContext: Context): Promise<void> }
    ).handleCallbackQuery.bind(adapter);
    await handleCallbackQuery(ctx);

    expect(callbackAnswers).toHaveLength(1);
    expect(callbackAnswers[0]?.text).toContain('outdated');

    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toContain('⚙️ Runtime settings');
    expect(edits[0]?.text).toContain('This menu is outdated. Showing latest settings.');
  });
});

interface UiCall {
  text: string;
  options?: unknown;
}

class FakeThreadControlService implements ThreadControlService {
  readonly resetCalls: string[] = [];

  constructor(private readonly state: ThreadRuntimeState) {}

  async getThreadRuntimeState(): Promise<ThreadRuntimeState> {
    return this.state;
  }

  async setThreadModel(): Promise<ThreadRuntimeState> {
    return this.state;
  }

  async setThreadThinkingLevel(): Promise<ThreadRuntimeState> {
    return this.state;
  }

  async resetThreadSession(threadKey: string): Promise<void> {
    this.resetCalls.push(threadKey);
  }
}

function createRuntimeState(): ThreadRuntimeState {
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
  };
}

function createRunServiceStub(): RunService {
  return {
    async ingestMessage() {
      throw new Error('not implemented in this test');
    },
    async getRun() {
      throw new Error('not implemented in this test');
    },
  } as unknown as RunService;
}

function createTextContext(text: string): {
  ctx: Context;
  replies: UiCall[];
} {
  const replies: UiCall[] = [];

  const ctx = {
    chat: {
      id: 101,
      type: 'private',
    },
    from: {
      id: 202,
    },
    message: {
      text,
    },
    update: {
      update_id: 1,
    },
    async reply(replyText: string, options?: unknown) {
      replies.push({ text: replyText, options });
      return undefined;
    },
  };

  return {
    ctx: ctx as unknown as Context,
    replies,
  };
}

function createCallbackContext(data: string): {
  ctx: Context;
  callbackAnswers: Array<{ text?: string }>;
  edits: UiCall[];
  replies: UiCall[];
} {
  const callbackAnswers: Array<{ text?: string }> = [];
  const edits: UiCall[] = [];
  const replies: UiCall[] = [];

  const ctx = {
    chat: {
      id: 101,
      type: 'private',
    },
    callbackQuery: {
      data,
      message: {
        message_id: 1,
      },
    },
    async answerCallbackQuery(options?: { text?: string }) {
      callbackAnswers.push({ text: options?.text });
      return undefined;
    },
    async editMessageText(text: string, options?: unknown) {
      edits.push({ text, options });
      return undefined;
    },
    async reply(text: string, options?: unknown) {
      replies.push({ text, options });
      return undefined;
    },
  };

  return {
    ctx: ctx as unknown as Context,
    callbackAnswers,
    edits,
    replies,
  };
}
