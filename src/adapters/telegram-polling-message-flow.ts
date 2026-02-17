import type { Bot, Context } from 'grammy';
import type { RunService } from '../server/service.js';
import { type DecodedInputImage, detectInputImageMimeType, InputImageValidationError } from '../shared/input-images.js';
import type { Logger } from '../shared/logger.js';
import { type TelegramRoute, telegramThreadKeyFromRoute } from '../shared/telegram-threading.js';
import {
  callTelegramWithRetry,
  routeFromMessageContext,
  telegramUserKey,
  userFacingError,
} from './telegram-polling-helpers.js';
import {
  assertTelegramFileSizeWithinLimit,
  buildTelegramFileUrl,
  selectLargestTelegramPhoto,
  type TelegramPhotoSize,
} from './telegram-polling-media.js';
import { pickWorkingReaction } from './telegram-polling-topics.js';

interface TelegramPollingMessageFlowOptions {
  bot: Bot;
  botToken: string;
  telegramApiRoot: string;
  runService: RunService;
  logger: Logger;
  reply: (ctx: Context, text: string) => Promise<void>;
  deliverRun: (runId: string, route: TelegramRoute) => Promise<void>;
}

export class TelegramPollingMessageFlow {
  constructor(private readonly options: TelegramPollingMessageFlowOptions) {}

  async handlePhotoMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !('photo' in message) || !Array.isArray(message.photo) || message.photo.length === 0) {
      return;
    }

    try {
      const largestPhoto = selectLargestTelegramPhoto(message.photo as TelegramPhotoSize[]);
      if (!largestPhoto) {
        throw new Error('photo message is missing file metadata');
      }

      assertTelegramFileSizeWithinLimit(largestPhoto.file_size, 'photo');

      const bytes = await this.downloadTelegramFile(largestPhoto.file_id);
      const mimeType = detectInputImageMimeType(bytes);
      if (!mimeType) {
        throw new InputImageValidationError('image_mime_type_unsupported', 'unsupported Telegram photo type');
      }

      await this.persistTelegramPendingImages(ctx, [
        {
          mimeType,
          data: bytes,
          filename: null,
        },
      ]);
    } catch (error) {
      await this.handleTelegramImageIngestError(ctx, error);
    }
  }

  async handleDocumentMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !('document' in message) || !message.document) {
      return;
    }

    try {
      assertTelegramFileSizeWithinLimit(message.document.file_size, 'document');

      const bytes = await this.downloadTelegramFile(message.document.file_id);
      const mimeType = detectInputImageMimeType(bytes);
      if (!mimeType) {
        throw new InputImageValidationError('image_mime_type_unsupported', 'unsupported Telegram image document type');
      }

      await this.persistTelegramPendingImages(ctx, [
        {
          mimeType,
          data: bytes,
          filename: message.document.file_name ?? null,
        },
      ]);
    } catch (error) {
      await this.handleTelegramImageIngestError(ctx, error);
    }
  }

  async handleAssistantMessage(ctx: Context, text: string, deliveryMode: 'steer' | 'followUp'): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      await this.options.reply(ctx, 'Message is empty.');
      return;
    }

    const route = routeFromMessageContext(ctx);
    const threadKey = telegramThreadKeyFromRoute(route);
    const userKey = telegramUserKey(ctx.from?.id);

    void this.sendWorkingReaction(ctx, route, threadKey);

    const ingested = await this.options.runService.ingestMessage({
      source: 'telegram',
      threadKey,
      userKey,
      text: prompt,
      deliveryMode,
      idempotencyKey: `telegram:update:${ctx.update.update_id}`,
    });

    await this.options.deliverRun(ingested.run.runId, route);
  }

  private async persistTelegramPendingImages(ctx: Context, images: DecodedInputImage[]): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      return;
    }

    const userKey = telegramUserKey(ctx.from?.id);
    if (!userKey) {
      throw new Error('telegram user id is required for image buffering');
    }

    const route = routeFromMessageContext(ctx);
    const threadKey = telegramThreadKeyFromRoute(route);

    const buffered = await this.options.runService.bufferTelegramImages({
      threadKey,
      userKey,
      telegramUpdateId: ctx.update.update_id,
      telegramMediaGroupId: typeof ctx.message?.media_group_id === 'string' ? ctx.message.media_group_id : null,
      images,
    });

    const count = buffered.insertedCount;
    if (count === 0) {
      return;
    }

    const suffix = count === 1 ? '' : 's';
    await this.options.reply(ctx, `Saved ${count} image${suffix}. Send text instructions.`);
  }

  private async handleTelegramImageIngestError(ctx: Context, error: unknown): Promise<void> {
    const route = routeFromMessageContext(ctx);
    const threadKey = telegramThreadKeyFromRoute(route);

    if (error instanceof InputImageValidationError) {
      this.options.logger.warn({
        event: 'telegram_image_ingest_rejected',
        reason: error.code,
        source: 'telegram',
        thread_key: threadKey,
      });
      await this.options.reply(ctx, `❌ ${error.code}: ${error.message}`);
      return;
    }

    const message = userFacingError(error);
    this.options.logger.error({
      event: 'telegram_image_ingest_failed',
      source: 'telegram',
      thread_key: threadKey,
      message,
    });
    await this.options.reply(ctx, `❌ ${message}`);
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const response = (await callTelegramWithRetry(() =>
      this.options.bot.api.raw.getFile({
        file_id: fileId,
      }),
    )) as { file_path?: unknown };

    if (typeof response.file_path !== 'string' || response.file_path.trim().length === 0) {
      throw new Error(`telegram getFile returned invalid file_path for ${fileId}`);
    }

    const fileResponse = await fetch(
      buildTelegramFileUrl(this.options.telegramApiRoot, this.options.botToken, response.file_path),
    );
    if (!fileResponse.ok) {
      throw new Error(`failed to download Telegram file ${fileId}: HTTP ${fileResponse.status}`);
    }

    const fileBytes = Buffer.from(await fileResponse.arrayBuffer());
    if (fileBytes.byteLength === 0) {
      throw new Error(`downloaded Telegram file ${fileId} is empty`);
    }

    return fileBytes;
  }

  private async sendWorkingReaction(ctx: Context, route: TelegramRoute, threadKey: string): Promise<void> {
    const messageId = ctx.message?.message_id;
    if (typeof messageId !== 'number') {
      return;
    }

    const reactionEmoji = pickWorkingReaction();

    try {
      await callTelegramWithRetry(() =>
        this.options.bot.api.raw.setMessageReaction({
          chat_id: route.chatId,
          message_id: messageId,
          reaction: [
            {
              type: 'emoji',
              emoji: reactionEmoji,
            },
          ],
        }),
      );
    } catch (error) {
      this.options.logger.debug({
        event: 'telegram_message_reaction_failed',
        chat_id: route.chatId,
        message_thread_id: route.messageThreadId,
        thread_key: threadKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
