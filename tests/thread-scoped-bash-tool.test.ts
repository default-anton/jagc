import { afterEach, describe, expect, test } from 'vitest';

import { createThreadScopedBashToolDefinition } from '../src/runtime/thread-scoped-bash-tool.js';

describe('createThreadScopedBashToolDefinition', () => {
  const initialTelegramChatId = process.env.JAGC_TELEGRAM_CHAT_ID;
  const initialTelegramTopicId = process.env.JAGC_TELEGRAM_TOPIC_ID;

  afterEach(() => {
    if (initialTelegramChatId === undefined) {
      delete process.env.JAGC_TELEGRAM_CHAT_ID;
    } else {
      process.env.JAGC_TELEGRAM_CHAT_ID = initialTelegramChatId;
    }

    if (initialTelegramTopicId === undefined) {
      delete process.env.JAGC_TELEGRAM_TOPIC_ID;
      return;
    }

    process.env.JAGC_TELEGRAM_TOPIC_ID = initialTelegramTopicId;
  });

  test('injects thread-scoped telegram environment values into bash execution env', async () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;

    const tool = createThreadScopedBashToolDefinition(process.cwd(), 'telegram:chat:101:topic:333', {
      exec: async (_command, _cwd, options) => {
        observedEnv = options.env;
        options.onData(Buffer.from('ok'));
        return { exitCode: 0 };
      },
    });

    await tool.execute('call-1', { command: 'echo ok' } as never);

    expect(observedEnv).toMatchObject({
      JAGC_THREAD_KEY: 'telegram:chat:101:topic:333',
      JAGC_TRANSPORT: 'telegram',
      JAGC_TELEGRAM_CHAT_ID: '101',
      JAGC_TELEGRAM_TOPIC_ID: '333',
    });
  });

  test('clears stale telegram ids for non-telegram thread-scoped bash executions', async () => {
    process.env.JAGC_TELEGRAM_CHAT_ID = '999';
    process.env.JAGC_TELEGRAM_TOPIC_ID = '888';

    let observedEnv: NodeJS.ProcessEnv | undefined;

    const tool = createThreadScopedBashToolDefinition(process.cwd(), 'cli:default', {
      exec: async (_command, _cwd, options) => {
        observedEnv = options.env;
        options.onData(Buffer.from('ok'));
        return { exitCode: 0 };
      },
    });

    await tool.execute('call-1', { command: 'echo ok' } as never);

    expect(observedEnv?.JAGC_THREAD_KEY).toBe('cli:default');
    expect(observedEnv?.JAGC_TRANSPORT).toBe('cli');
    expect(observedEnv?.JAGC_TELEGRAM_CHAT_ID).toBeUndefined();
    expect(observedEnv?.JAGC_TELEGRAM_TOPIC_ID).toBeUndefined();
  });
});
