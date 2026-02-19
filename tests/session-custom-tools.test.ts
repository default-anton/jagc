import { describe, expect, test } from 'vitest';

import { createSessionCustomTools } from '../src/runtime/session-custom-tools.js';

describe('createSessionCustomTools', () => {
  test('registers telegram_send_files only for Telegram threads with bot token', () => {
    const tools = createSessionCustomTools({
      workspaceDir: process.cwd(),
      threadKey: 'telegram:chat:101',
      telegramBotToken: '123456:TESTTOKEN',
      telegramApiRoot: 'http://127.0.0.1:9876',
    });

    expect(tools.map((tool) => tool.name)).toEqual(['bash', 'telegram_send_files']);
  });

  test('does not register telegram_send_files for non-Telegram threads', () => {
    const tools = createSessionCustomTools({
      workspaceDir: process.cwd(),
      threadKey: 'cli:default',
      telegramBotToken: '123456:TESTTOKEN',
    });

    expect(tools.map((tool) => tool.name)).toEqual(['bash']);
  });

  test('does not register telegram_send_files when bot token is missing', () => {
    const tools = createSessionCustomTools({
      workspaceDir: process.cwd(),
      threadKey: 'telegram:chat:101',
    });

    expect(tools.map((tool) => tool.name)).toEqual(['bash']);
  });
});
