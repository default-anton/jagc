const telegramWorkingReactionEmojis = ['👍', '🔥', '👏', '😁', '🤔', '🤯', '🎉', '🤩', '🙏', '👌', '❤'] as const;

export function readPrivateTopicsEnabledFromBotInfo(botInfo: unknown): boolean | null {
  if (!botInfo || typeof botInfo !== 'object') {
    return null;
  }

  const raw = (botInfo as { has_topics_enabled?: unknown }).has_topics_enabled;
  if (typeof raw === 'boolean') {
    return raw;
  }

  return null;
}

export function mapTelegramTopicCreationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (/chat is not a forum/iu.test(message)) {
    return new Error(
      'telegram_topics_unavailable: this chat has no topic mode enabled for the bot; enable private topics in BotFather and retry',
    );
  }

  if (/message thread not found/iu.test(message)) {
    return new Error(
      'telegram_topics_unavailable: Telegram could not resolve the target topic; open the chat topic and retry',
    );
  }

  return error instanceof Error ? error : new Error(message);
}

export function mapTelegramTopicDeletionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (/chat is not a forum/iu.test(message)) {
    return new Error(
      'telegram_topics_unavailable: this chat has no topic mode enabled for the bot; enable private topics in BotFather and retry',
    );
  }

  if (/message thread not found/iu.test(message)) {
    return new Error('telegram_topic_not_found: this topic no longer exists or is already deleted.');
  }

  return error instanceof Error ? error : new Error(message);
}

export function pickWorkingReaction(
  randomSource: () => number = Math.random,
): (typeof telegramWorkingReactionEmojis)[number] {
  const fallbackEmoji = telegramWorkingReactionEmojis[0] ?? '👍';
  const randomIndex = Math.floor(randomSource() * telegramWorkingReactionEmojis.length);
  return telegramWorkingReactionEmojis[randomIndex] ?? fallbackEmoji;
}
