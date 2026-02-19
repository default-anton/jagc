export interface TelegramRoute {
  chatId: number;
  messageThreadId?: number;
}

export interface TelegramBotApiRoutePayload {
  chat_id: number;
  message_thread_id?: number;
}

const telegramThreadKeyPattern = /^telegram:chat:(-?\d+)(?::topic:(\d+))?$/u;

export function normalizeTelegramMessageThreadId(messageThreadId: number | undefined): number | undefined {
  if (messageThreadId === undefined) {
    return undefined;
  }

  if (!Number.isInteger(messageThreadId)) {
    throw new Error('telegram route message_thread_id must be an integer when provided');
  }

  if (messageThreadId <= 0) {
    throw new Error('telegram route message_thread_id must be a positive integer when provided');
  }

  if (messageThreadId === 1) {
    return undefined;
  }

  return messageThreadId;
}

export function telegramBotApiRoutePayload(route: TelegramRoute): TelegramBotApiRoutePayload {
  const messageThreadId = normalizeTelegramMessageThreadId(route.messageThreadId);

  return {
    chat_id: route.chatId,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  };
}

export function telegramThreadKeyFromRoute(route: TelegramRoute): string {
  if (!Number.isFinite(route.chatId)) {
    throw new Error('telegram route chatId must be a finite number');
  }

  const normalizedThreadId = normalizeTelegramMessageThreadId(route.messageThreadId);
  if (normalizedThreadId === undefined) {
    return `telegram:chat:${route.chatId}`;
  }

  return `telegram:chat:${route.chatId}:topic:${normalizedThreadId}`;
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

  if (messageThreadId === 1) {
    return {
      chatId,
    };
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

  const normalizedThreadId = normalizeTelegramMessageThreadId(messageThreadId);
  if (normalizedThreadId === undefined) {
    return {
      chatId,
    };
  }

  return {
    chatId,
    messageThreadId: normalizedThreadId,
  };
}
