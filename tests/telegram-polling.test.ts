import { describe, expect, test } from 'vitest';

import { parseTelegramCallbackData } from '../src/adapters/telegram-controls-callbacks.js';
import { parseTelegramCommand } from '../src/adapters/telegram-polling.js';

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
    expect(parseTelegramCallbackData('s:refresh')).toEqual({ kind: 'settings_refresh' });
  });

  test('parses model picker actions', () => {
    expect(parseTelegramCallbackData('m:providers:2')).toEqual({ kind: 'model_providers', page: 2 });
    expect(parseTelegramCallbackData('m:list:openai:0')).toEqual({ kind: 'model_list', provider: 'openai', page: 0 });
    expect(parseTelegramCallbackData('m:set:vercel-ai-gateway:gpt-5:1')).toEqual({
      kind: 'model_set',
      provider: 'vercel-ai-gateway',
      modelId: 'gpt-5',
      page: 1,
    });
    expect(parseTelegramCallbackData('m:set:openrouter:deepseek%2Fdeepseek-r1:0')).toEqual({
      kind: 'model_set',
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-r1',
      page: 0,
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
    expect(parseTelegramCallbackData('unknown')).toBeNull();
  });
});
