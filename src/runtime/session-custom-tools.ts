import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import { createTelegramSendFilesToolDefinition } from './telegram-send-files-tool.js';
import { createThreadScopedBashToolDefinition } from './thread-scoped-bash-tool.js';

interface SessionCustomToolsOptions {
  workspaceDir: string;
  threadKey: string;
  telegramBotToken?: string;
  telegramApiRoot?: string;
}

export function createSessionCustomTools(options: SessionCustomToolsOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createThreadScopedBashToolDefinition(options.workspaceDir, options.threadKey) as ToolDefinition,
  ];

  const botToken = options.telegramBotToken?.trim();
  if (!botToken) {
    return tools;
  }

  const telegramTool = createTelegramSendFilesToolDefinition({
    workspaceDir: options.workspaceDir,
    threadKey: options.threadKey,
    botToken,
    telegramApiRoot: options.telegramApiRoot,
  });

  if (telegramTool) {
    tools.push(telegramTool);
  }

  return tools;
}
