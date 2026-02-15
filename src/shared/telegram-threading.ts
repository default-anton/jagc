export interface TelegramRoute {
  chatId: number;
  messageThreadId?: number;
}

const telegramThreadKeyPattern = /^telegram:chat:(-?\d+)(?::topic:(\d+))?$/u;

export function telegramThreadKeyFromRoute(route: TelegramRoute): string {
  if (!Number.isFinite(route.chatId)) {
    throw new Error('telegram route chatId must be a finite number');
  }

  if (route.messageThreadId === undefined) {
    return `telegram:chat:${route.chatId}`;
  }

  if (!Number.isInteger(route.messageThreadId) || route.messageThreadId <= 0) {
    throw new Error('telegram route messageThreadId must be a positive integer when provided');
  }

  return `telegram:chat:${route.chatId}:topic:${route.messageThreadId}`;
}

export function telegramRouteFromThreadKey(threadKey: string): TelegramRoute | null {
  const match = threadKey.match(telegramThreadKeyPattern);
  if (!match?.[1]) {
    return null;
  }

  const chatId = Number(match[1]);
  if (!Number.isFinite(chatId)) {
    return null;
  }

  const messageThreadRaw = match[2];
  if (!messageThreadRaw) {
    return {
      chatId,
    };
  }

  const messageThreadId = Number(messageThreadRaw);
  if (!Number.isInteger(messageThreadId) || messageThreadId <= 0) {
    return null;
  }

  return {
    chatId,
    messageThreadId,
  };
}

export function telegramRoute(chatId: number | undefined, messageThreadId?: number): TelegramRoute {
  if (chatId === undefined) {
    throw new Error('telegram message has no chat id');
  }

  if (messageThreadId === undefined) {
    return {
      chatId,
    };
  }

  if (!Number.isInteger(messageThreadId) || messageThreadId <= 0) {
    throw new Error('telegram message_thread_id must be a positive integer when present');
  }

  return {
    chatId,
    messageThreadId,
  };
}
