import { telegramRouteFromThreadKey } from '../shared/telegram-threading.js';

const defaultTransport = 'thread';

export interface ThreadToolEnvironment {
  JAGC_THREAD_KEY: string;
  JAGC_TRANSPORT: string;
  JAGC_TELEGRAM_CHAT_ID?: string;
  JAGC_TELEGRAM_TOPIC_ID?: string;
}

export function buildThreadToolEnvironment(threadKey: string): ThreadToolEnvironment {
  const telegramRoute = telegramRouteFromThreadKey(threadKey);
  if (telegramRoute) {
    return {
      JAGC_THREAD_KEY: threadKey,
      JAGC_TRANSPORT: 'telegram',
      JAGC_TELEGRAM_CHAT_ID: String(telegramRoute.chatId),
      JAGC_TELEGRAM_TOPIC_ID:
        telegramRoute.messageThreadId !== undefined ? String(telegramRoute.messageThreadId) : undefined,
    };
  }

  return {
    JAGC_THREAD_KEY: threadKey,
    JAGC_TRANSPORT: transportFromThreadKey(threadKey),
  };
}

export function withThreadToolEnvironment(env: NodeJS.ProcessEnv, threadKey: string): NodeJS.ProcessEnv {
  const threadEnv = buildThreadToolEnvironment(threadKey);
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    ...threadEnv,
  };

  if (threadEnv.JAGC_TELEGRAM_CHAT_ID === undefined) {
    delete nextEnv.JAGC_TELEGRAM_CHAT_ID;
  }

  if (threadEnv.JAGC_TELEGRAM_TOPIC_ID === undefined) {
    delete nextEnv.JAGC_TELEGRAM_TOPIC_ID;
  }

  return nextEnv;
}

function transportFromThreadKey(threadKey: string): string {
  const prefix = threadKey.split(':')[0]?.trim().toLowerCase();
  if (!prefix) {
    return defaultTransport;
  }

  return prefix;
}
