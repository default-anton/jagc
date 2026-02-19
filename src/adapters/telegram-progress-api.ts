import type { Bot } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { normalizeTelegramMessageThreadId, type TelegramRoute } from '../shared/telegram-threading.js';

export { callTelegramWithRetry } from './telegram-retry.js';

export function sendProgressMessage(
  bot: Bot,
  route: TelegramRoute,
  text: string,
  entities: MessageEntity[],
): Promise<{ message_id: number }> {
  return bot.api.raw.sendMessage({
    ...routePayload(route),
    text,
    entities,
  }) as Promise<{ message_id: number }>;
}

export function editProgressMessage(
  bot: Bot,
  route: TelegramRoute,
  messageId: number,
  text: string,
  entities: MessageEntity[],
): Promise<unknown> {
  return bot.api.raw.editMessageText({
    ...routePayload(route),
    message_id: messageId,
    text,
    entities,
  });
}

export function deleteProgressMessage(bot: Bot, route: TelegramRoute, messageId: number): Promise<unknown> {
  return bot.api.raw.deleteMessage({
    ...routePayload(route),
    message_id: messageId,
  });
}

export function sendProgressChatAction(bot: Bot, route: TelegramRoute, action: 'typing'): Promise<unknown> {
  return bot.api.raw.sendChatAction({
    ...routePayload(route),
    action,
  });
}

function routePayload(route: TelegramRoute): { chat_id: number; message_thread_id?: number } {
  const messageThreadId = normalizeTelegramMessageThreadId(route.messageThreadId);

  return {
    chat_id: route.chatId,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  };
}
