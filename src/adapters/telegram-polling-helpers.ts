import type { Context } from 'grammy';

import type { TelegramRoute } from '../shared/telegram-threading.js';
import { telegramRoute } from '../shared/telegram-threading.js';

export interface ParsedTelegramCommand {
  command: string;
  args: string;
}

export { callTelegramWithRetry } from './telegram-retry.js';

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  return {
    command: match[1]?.toLowerCase() ?? '',
    args: match[2] ?? '',
  };
}

export function helpText(): string {
  return [
    'jagc Telegram commands:',
    '/settings — open runtime settings',
    '/cancel — stop the active run in this thread (session stays intact)',
    '/new — reset this thread session (next message starts fresh)',
    '/delete — delete the current Telegram topic thread',
    '/share — export this thread session and upload a secret gist',
    '/model — open model picker',
    '/thinking — open thinking picker',
    '/auth — open provider login controls',
    '/steer <message> — send an interrupting message (explicit steer)',
    'Any other /command is forwarded to the assistant as a normal message.',
  ].join('\n');
}

export function routeFromMessageContext(ctx: Context): TelegramRoute {
  return telegramRoute(ctx.chat?.id, ctx.message?.message_thread_id);
}

export function routeFromCallbackContext(ctx: Context): TelegramRoute {
  return telegramRoute(ctx.chat?.id, ctx.callbackQuery?.message?.message_thread_id);
}

export function trimTopicTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'task';
  }

  if (trimmed.length <= 128) {
    return trimmed;
  }

  return trimmed.slice(0, 128);
}

export function formatTaskTopicTitle(_taskId: string, title: string): string {
  return trimTopicTitle(title);
}

export function telegramUserKey(userId: number | undefined): string | undefined {
  if (userId === undefined) {
    return undefined;
  }

  return `telegram:user:${userId}`;
}

export function formatShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function canonicalizeTelegramUserId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`allowedTelegramUserIds contains invalid Telegram user id '${value}'.`);
  }

  return BigInt(trimmed).toString();
}

export function userFacingError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 180);
  }

  return 'Action failed. Please try again.';
}
