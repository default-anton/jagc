import { describe, expect, test } from 'vitest';

import { parseTelegramCommand } from '../src/adapters/telegram-polling.js';

describe('parseTelegramCommand', () => {
  test('parses command with args', () => {
    expect(parseTelegramCommand('/model openai/gpt-4.1')).toEqual({
      command: 'model',
      args: 'openai/gpt-4.1',
    });
  });

  test('parses command addressed to bot username', () => {
    expect(parseTelegramCommand('/thinking@jagc_bot high')).toEqual({
      command: 'thinking',
      args: 'high',
    });
  });

  test('returns null for plain text', () => {
    expect(parseTelegramCommand('hello there')).toBeNull();
  });
});
