import { type TelegramRoute, telegramRouteFromThreadKey } from '../shared/telegram-threading.js';
import type { ScheduledTaskDeliveryTarget, ScheduledTaskRecord } from './scheduled-task-types.js';

export function parseTelegramTaskRoute(target: ScheduledTaskDeliveryTarget): TelegramRoute | null {
  if (target.provider !== 'telegram' || !target.route) {
    return null;
  }

  const chatIdRaw = target.route.chatId;
  if (typeof chatIdRaw !== 'number' || !Number.isFinite(chatIdRaw)) {
    return null;
  }

  const messageThreadIdRaw = target.route.messageThreadId;
  if (messageThreadIdRaw === undefined) {
    return { chatId: chatIdRaw };
  }

  if (typeof messageThreadIdRaw !== 'number' || !Number.isInteger(messageThreadIdRaw) || messageThreadIdRaw <= 0) {
    return null;
  }

  return {
    chatId: chatIdRaw,
    messageThreadId: messageThreadIdRaw,
  };
}

export function deliveryTargetFromCreatorThread(threadKey: string): ScheduledTaskDeliveryTarget {
  const telegramRoute = telegramRouteFromThreadKey(threadKey);
  if (telegramRoute) {
    return {
      provider: 'telegram',
      route: {
        chatId: telegramRoute.chatId,
      },
      metadata: telegramRoute.messageThreadId
        ? {
            creatorMessageThreadId: telegramRoute.messageThreadId,
          }
        : undefined,
    };
  }

  const prefix = sanitizeThreadPrefix(threadKey.split(':')[0] ?? 'thread');
  return {
    provider: prefix,
    route: {
      threadKey,
    },
  };
}

export function sanitizeThreadPrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return 'thread';
  }

  return normalized.replaceAll(/[^a-z0-9_-]/gu, '_');
}

export function idempotencyKeyForTaskOccurrence(taskId: string, scheduledFor: string): string {
  return `task:${taskId}:scheduled_for:${scheduledFor}`;
}

export function buildTaskRunInstructions(task: ScheduledTaskRecord, scheduledFor: string): string {
  return [
    '[SCHEDULED TASK]',
    `Task: ${task.title}`,
    `Task ID: ${task.taskId}`,
    `Scheduled for (UTC): ${scheduledFor}`,
    `Timezone: ${task.timezone}`,
    '',
    task.instructions,
  ].join('\n');
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
