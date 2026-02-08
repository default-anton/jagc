import type { Context, InlineKeyboard } from 'grammy';

export const telegramCallbackDataMaxBytes = 64;

export async function replyUi(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const options = { reply_markup: keyboard };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        return;
      }
    }
  }

  await ctx.reply(text, options);
}

export function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
): {
  items: T[];
  page: number;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize;

  return {
    items: items.slice(startIndex, endIndex),
    page,
    totalPages,
  };
}

export function callbackDataByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function isCallbackDataWithinLimit(value: string): boolean {
  return callbackDataByteLength(value) <= telegramCallbackDataMaxBytes;
}

export function addCallbackButton(keyboard: InlineKeyboard, text: string, callbackData: string): boolean {
  if (!isCallbackDataWithinLimit(callbackData)) {
    return false;
  }

  keyboard.text(text, callbackData);
  return true;
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('message is not modified');
}
