import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

import { type Bot, InputFile } from 'grammy';
import { callTelegramWithRetry } from '../adapters/telegram-retry.js';
import { detectInputImageMimeType } from '../shared/input-images.js';
import type { TelegramRoute } from '../shared/telegram-threading.js';

export const maxFilesPerCall = 50;
export const maxCaptionLength = 1024;
export const telegramPhotoMaxBytes = 10 * 1024 * 1024;
export const telegramDocumentMaxBytes = 50 * 1024 * 1024;
export const telegramMediaGroupMaxItems = 10;
export const defaultRetryAttempts = 3;

const photoMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const videoExtensions = new Set(['.mp4']);
const audioExtensions = new Set(['.mp3', '.m4a']);

export const requestedSendKinds = ['auto', 'photo', 'video', 'audio', 'document'] as const;
export type RequestedSendKind = (typeof requestedSendKinds)[number];

export const sendOrder = ['photo', 'video', 'audio', 'document'] as const;
export type SendKind = (typeof sendOrder)[number];

export type CaptionMode = 'per_file' | 'first_only';

export interface PreparedFile {
  path: string;
  resolvedPath: string;
  kind: SendKind;
  caption?: string;
}

export interface ItemResult {
  path: string;
  resolved_path: string;
  kind: SendKind;
  status: 'sent' | 'failed';
  telegram_message_id?: number;
  warning?: string;
  error?: string;
}

export interface ToolResultDetails {
  ok: boolean;
  route?: {
    chat_id: number;
    message_thread_id?: number;
  };
  sent: {
    photo_groups: number;
    photos: number;
    videos: number;
    audios: number;
    documents: number;
  };
  warnings: string[];
  items: ItemResult[];
  error_code?: string;
  error_message?: string;
}

export class ToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export async function prepareFiles(
  files: Array<{ path: string; kind?: RequestedSendKind; caption?: string }>,
  workspaceDir: string,
  warnings: string[],
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];

  for (const file of files) {
    const resolvedPath = resolveInputPath(file.path, workspaceDir);

    const stats = await stat(resolvedPath).catch((error) => {
      throw new ToolInputError(
        'file_not_found',
        `File not found or unreadable: ${resolvedPath} (${errorMessage(error)})`,
      );
    });

    if (!stats.isFile()) {
      throw new ToolInputError('not_a_file', `Path is not a file: ${resolvedPath}`);
    }

    const sizeBytes = stats.size;
    if (sizeBytes > telegramDocumentMaxBytes) {
      throw new ToolInputError(
        'file_too_large',
        `File exceeds Telegram bot non-photo limit (${telegramDocumentMaxBytes} bytes): ${resolvedPath}`,
      );
    }

    const mimeType = await detectFileMimeType(resolvedPath).catch((error) => {
      throw new ToolInputError('file_unreadable', `File is unreadable: ${resolvedPath} (${errorMessage(error)})`);
    });
    const normalizedCaption = normalizeCaption(file.caption, warnings, file.path);
    const requestedKind = file.kind ?? 'auto';

    const kind = resolveSendKind({
      requestedKind,
      filePath: file.path,
      resolvedPath,
      mimeType,
      sizeBytes,
      warnings,
    });

    prepared.push({
      path: file.path,
      resolvedPath,
      kind,
      caption: normalizedCaption,
    });
  }

  return prepared;
}

export function applyCaptionMode(files: PreparedFile[], mode: CaptionMode): void {
  if (mode !== 'first_only') {
    return;
  }

  let consumed = false;
  for (const file of files) {
    if (!file.caption) {
      continue;
    }

    if (consumed) {
      file.caption = undefined;
      continue;
    }

    consumed = true;
  }
}

export async function sendPhotos(
  bot: Bot,
  route: TelegramRoute,
  photos: PreparedFile[],
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  for (const group of chunkBy(photos, telegramMediaGroupMaxItems)) {
    if (group.length === 1) {
      const [singlePhoto] = group;
      if (singlePhoto) {
        await sendSinglePhoto(bot, route, singlePhoto, result, retryAttempts);
      }
      continue;
    }

    await sendPhotoGroup(bot, route, group, result, retryAttempts);
  }
}

async function sendSinglePhoto(
  bot: Bot,
  route: TelegramRoute,
  photo: PreparedFile,
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  try {
    const message = await callTelegramWithRetry(
      () =>
        bot.api.sendPhoto(route.chatId, new InputFile(photo.resolvedPath), {
          ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
          ...(photo.caption ? { caption: photo.caption } : {}),
        }),
      retryAttempts,
    );

    result.sent.photos += 1;
    result.items.push({
      path: photo.path,
      resolved_path: photo.resolvedPath,
      kind: 'photo',
      status: 'sent',
      telegram_message_id: message.message_id,
    });
  } catch (error) {
    result.items.push({
      path: photo.path,
      resolved_path: photo.resolvedPath,
      kind: 'photo',
      status: 'failed',
      error: errorMessage(error),
    });

    throw new ToolInputError('telegram_api_error', `failed to send photo ${photo.path}: ${errorMessage(error)}`);
  }
}

async function sendPhotoGroup(
  bot: Bot,
  route: TelegramRoute,
  group: PreparedFile[],
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  try {
    const media = group.map((photo) => ({
      type: 'photo' as const,
      media: new InputFile(photo.resolvedPath),
      ...(photo.caption ? { caption: photo.caption } : {}),
    }));

    const messages = await callTelegramWithRetry(
      () =>
        bot.api.sendMediaGroup(route.chatId, media, {
          ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
        }),
      retryAttempts,
    );

    result.sent.photo_groups += 1;

    for (const [index, photo] of group.entries()) {
      const messageId = messages[index]?.message_id;
      result.sent.photos += 1;
      result.items.push({
        path: photo.path,
        resolved_path: photo.resolvedPath,
        kind: 'photo',
        status: 'sent',
        ...(typeof messageId === 'number' ? { telegram_message_id: messageId } : {}),
      });
    }
  } catch (error) {
    for (const photo of group) {
      result.items.push({
        path: photo.path,
        resolved_path: photo.resolvedPath,
        kind: 'photo',
        status: 'failed',
        error: errorMessage(error),
      });
    }

    throw new ToolInputError('telegram_api_error', `failed to send photo media group: ${errorMessage(error)}`);
  }
}

type DirectSendKind = Exclude<SendKind, 'photo'>;

const sentCounterByKind: Record<DirectSendKind, 'videos' | 'audios' | 'documents'> = {
  video: 'videos',
  audio: 'audios',
  document: 'documents',
};

async function sendFilesIndividually(
  files: PreparedFile[],
  kind: DirectSendKind,
  result: ToolResultDetails,
  send: (file: PreparedFile) => Promise<{ message_id: number }>,
): Promise<void> {
  const sentCounter = sentCounterByKind[kind];

  for (const file of files) {
    try {
      const message = await send(file);
      result.sent[sentCounter] += 1;
      result.items.push({
        path: file.path,
        resolved_path: file.resolvedPath,
        kind,
        status: 'sent',
        telegram_message_id: message.message_id,
      });
    } catch (error) {
      result.items.push({
        path: file.path,
        resolved_path: file.resolvedPath,
        kind,
        status: 'failed',
        error: errorMessage(error),
      });

      throw new ToolInputError('telegram_api_error', `failed to send ${kind} ${file.path}: ${errorMessage(error)}`);
    }
  }
}

export async function sendVideos(
  bot: Bot,
  route: TelegramRoute,
  videos: PreparedFile[],
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  await sendFilesIndividually(videos, 'video', result, (video) =>
    callTelegramWithRetry(
      () =>
        bot.api.sendVideo(route.chatId, new InputFile(video.resolvedPath), {
          ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
          ...(video.caption ? { caption: video.caption } : {}),
        }),
      retryAttempts,
    ),
  );
}

export async function sendAudios(
  bot: Bot,
  route: TelegramRoute,
  audios: PreparedFile[],
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  await sendFilesIndividually(audios, 'audio', result, (audio) =>
    callTelegramWithRetry(
      () =>
        bot.api.sendAudio(route.chatId, new InputFile(audio.resolvedPath), {
          ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
          ...(audio.caption ? { caption: audio.caption } : {}),
        }),
      retryAttempts,
    ),
  );
}

export async function sendDocuments(
  bot: Bot,
  route: TelegramRoute,
  documents: PreparedFile[],
  result: ToolResultDetails,
  retryAttempts: number,
): Promise<void> {
  await sendFilesIndividually(documents, 'document', result, (document) =>
    callTelegramWithRetry(
      () =>
        bot.api.sendDocument(route.chatId, new InputFile(document.resolvedPath), {
          ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
          ...(document.caption ? { caption: document.caption } : {}),
        }),
      retryAttempts,
    ),
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function resolveInputPath(path: string, workspaceDir: string): string {
  return isAbsolute(path) ? path : resolve(workspaceDir, path);
}

function normalizeCaption(caption: string | undefined, warnings: string[], path: string): string | undefined {
  if (!caption) {
    return undefined;
  }

  const normalized = caption.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.length <= maxCaptionLength) {
    return normalized;
  }

  warnings.push(`caption for ${path} exceeded ${maxCaptionLength} characters and was truncated`);
  return normalized.slice(0, maxCaptionLength);
}

async function detectFileMimeType(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    const readResult = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, readResult.bytesRead);
    if (bytes.length === 0) {
      return null;
    }

    return detectInputImageMimeType(bytes);
  } finally {
    await handle.close();
  }
}

interface KindResolutionInput {
  requestedKind: RequestedSendKind;
  filePath: string;
  resolvedPath: string;
  mimeType: string | null;
  sizeBytes: number;
  warnings: string[];
}

interface KindClassifier {
  kind: Exclude<SendKind, 'document'>;
  canSend: (input: KindResolutionInput) => boolean;
}

const classifiersByKind: Record<Exclude<RequestedSendKind, 'auto' | 'document'>, KindClassifier> = {
  photo: {
    kind: 'photo',
    canSend: ({ mimeType, sizeBytes }) => canSendAsPhoto(mimeType, sizeBytes),
  },
  video: {
    kind: 'video',
    canSend: ({ resolvedPath }) => canSendAsVideo(resolvedPath),
  },
  audio: {
    kind: 'audio',
    canSend: ({ resolvedPath }) => canSendAsAudio(resolvedPath),
  },
};

const autoKindClassifiers = [
  classifiersByKind.photo,
  classifiersByKind.video,
  classifiersByKind.audio,
] satisfies KindClassifier[];

function resolveSendKind(input: KindResolutionInput): SendKind {
  const { requestedKind, filePath, warnings } = input;

  if (requestedKind === 'document') {
    return 'document';
  }

  if (requestedKind === 'auto') {
    for (const classifier of autoKindClassifiers) {
      if (classifier.canSend(input)) {
        return classifier.kind;
      }
    }

    return 'document';
  }

  const classifier = classifiersByKind[requestedKind];
  if (classifier.canSend(input)) {
    return classifier.kind;
  }

  warnings.push(`downgraded ${filePath} to document because it does not meet ${requestedKind} constraints`);
  return 'document';
}

function canSendAsPhoto(mimeType: string | null, sizeBytes: number): boolean {
  if (!mimeType || !photoMimes.has(mimeType)) {
    return false;
  }
  return sizeBytes <= telegramPhotoMaxBytes;
}

function canSendAsVideo(path: string): boolean {
  return videoExtensions.has(normalizeExtension(path));
}

function canSendAsAudio(path: string): boolean {
  return audioExtensions.has(normalizeExtension(path));
}

function normalizeExtension(path: string): string {
  return extname(path).toLowerCase();
}

function chunkBy<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
