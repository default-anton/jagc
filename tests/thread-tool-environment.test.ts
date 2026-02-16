import { describe, expect, test } from 'vitest';

import { buildThreadToolEnvironment, withThreadToolEnvironment } from '../src/runtime/thread-tool-environment.js';

describe('thread tool environment', () => {
  test('builds telegram topic environment from topic thread keys', () => {
    expect(buildThreadToolEnvironment('telegram:chat:101:topic:333')).toEqual({
      JAGC_THREAD_KEY: 'telegram:chat:101:topic:333',
      JAGC_TRANSPORT: 'telegram',
      JAGC_TELEGRAM_CHAT_ID: '101',
      JAGC_TELEGRAM_TOPIC_ID: '333',
    });
  });

  test('omits telegram topic id for base telegram thread keys', () => {
    expect(buildThreadToolEnvironment('telegram:chat:101')).toEqual({
      JAGC_THREAD_KEY: 'telegram:chat:101',
      JAGC_TRANSPORT: 'telegram',
      JAGC_TELEGRAM_CHAT_ID: '101',
      JAGC_TELEGRAM_TOPIC_ID: undefined,
    });
  });

  test('uses thread prefix as transport for non-telegram thread keys', () => {
    expect(buildThreadToolEnvironment('cli:default')).toEqual({
      JAGC_THREAD_KEY: 'cli:default',
      JAGC_TRANSPORT: 'cli',
    });
  });

  test('clears stale telegram env keys when thread is non-telegram', () => {
    const env = withThreadToolEnvironment(
      {
        EXISTING: '1',
        JAGC_TELEGRAM_CHAT_ID: '101',
        JAGC_TELEGRAM_TOPIC_ID: '333',
      },
      'cli:default',
    );

    expect(env).toEqual({
      EXISTING: '1',
      JAGC_THREAD_KEY: 'cli:default',
      JAGC_TRANSPORT: 'cli',
    });
  });
});
