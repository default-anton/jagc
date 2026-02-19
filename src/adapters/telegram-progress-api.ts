import type { Bot } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { type TelegramRoute, telegramBotApiRoutePayload } from '../shared/telegram-threading.js';

export { callTelegramWithRetry } from './telegram-retry.js';

export function sendProgressMessage(
  bot: Bot,
  route: TelegramRoute,
  text: string,
  entities: MessageEntity[],
): Promise<{ message_id: number }> {
  return bot.api.raw.sendMessage({
    ...telegramBotApiRoutePayload(route),
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
    ...telegramBotApiRoutePayload(route),
    message_id: messageId,
    text,
    entities,
  });
}

export function deleteProgressMessage(bot: Bot, route: TelegramRoute, messageId: number): Promise<unknown> {
  return bot.api.raw.deleteMessage({
    ...telegramBotApiRoutePayload(route),
    message_id: messageId,
  });
}

export function sendProgressChatAction(bot: Bot, route: TelegramRoute, action: 'typing'): Promise<unknown> {
  return bot.api.raw.sendChatAction({
    ...telegramBotApiRoutePayload(route),
    action,
  });
}
