import { homedir } from 'node:os';
import { join } from 'node:path';

import { formatShellArgument } from './telegram-polling-helpers.js';

const defaultWorkspaceDir = join(homedir(), '.jagc');

export function isTelegramUserAuthorized(allowedTelegramUserIds: Set<string>, userId: number | undefined): boolean {
  if (userId === undefined) {
    return false;
  }

  return allowedTelegramUserIds.has(String(userId));
}

export function buildTelegramAllowCommand(userId: number | undefined, workspaceDir: string | null): string | null {
  if (userId === undefined) {
    return null;
  }

  const commandParts = ['jagc', 'telegram', 'allow', '--user-id', String(userId)];
  if (workspaceDir && workspaceDir !== defaultWorkspaceDir) {
    commandParts.push('--workspace-dir', workspaceDir);
  }

  return commandParts.map((part) => formatShellArgument(part)).join(' ');
}
