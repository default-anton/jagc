import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { Bot } from 'grammy';
import { z } from 'zod';
import { type TelegramRoute, telegramRouteFromThreadKey } from '../shared/telegram-threading.js';
import {
  applyCaptionMode,
  type CaptionMode,
  defaultRetryAttempts,
  errorMessage,
  maxCaptionLength,
  maxFilesPerCall,
  type PreparedFile,
  prepareFiles,
  sendDocuments,
  sendPhotos,
  ToolInputError,
  type ToolResultDetails,
} from './telegram-send-files-core.js';

const defaultTelegramApiRoot = 'https://api.telegram.org';
const toolName = 'telegram_send_files';
const fileKinds = ['auto', 'photo', 'document'] as const;
const captionModes = ['per_file', 'first_only'] as const;

const toolParametersSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      maxItems: maxFilesPerCall,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to send (relative paths resolve from workspace root)',
          },
          kind: {
            type: 'string',
            enum: fileKinds,
            description: 'Delivery kind. auto chooses photo for jpg/png/webp <=10MB, otherwise document.',
          },
          caption: {
            type: 'string',
            description: `Optional caption. Truncated to ${maxCaptionLength} characters when longer.`,
          },
        },
      },
    },
    caption_mode: {
      type: 'string',
      enum: captionModes,
      description: 'Caption behavior. first_only sends only the first non-empty caption in output order.',
    },
  },
} as const;

const inputSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        kind: z.enum(fileKinds).optional(),
        caption: z.string().optional(),
      }),
    )
    .min(1)
    .max(maxFilesPerCall),
  caption_mode: z.enum(captionModes).optional(),
});

type ToolInput = z.infer<typeof inputSchema>;

interface TelegramSendFilesToolOptions {
  workspaceDir: string;
  threadKey: string;
  botToken: string;
  telegramApiRoot?: string;
  retryAttempts?: number;
}

export function createTelegramSendFilesToolDefinition(options: TelegramSendFilesToolOptions): ToolDefinition | null {
  const route = telegramRouteFromThreadKey(options.threadKey);
  if (!route) {
    return null;
  }

  const bot = new Bot(options.botToken, {
    client: {
      apiRoot: (options.telegramApiRoot ?? defaultTelegramApiRoot).replace(/\/$/u, ''),
    },
  });

  return {
    name: toolName,
    label: toolName,
    description:
      'Send files directly to the active Telegram chat/thread. Photos are grouped into albums (up to 10) and sent before documents.',
    parameters: toolParametersSchema as never,
    execute: async (_toolCallId, rawParams) => {
      const result = createToolResult(route);

      try {
        const params: ToolInput = inputSchema.parse(rawParams);
        const captionMode: CaptionMode = params.caption_mode ?? 'per_file';
        const prepared = await prepareFiles(params.files, options.workspaceDir, result.warnings);
        const { photos, documents } = partitionPreparedFiles(prepared);

        applyCaptionMode([...photos, ...documents], captionMode);

        const retryAttempts = options.retryAttempts ?? defaultRetryAttempts;
        await sendPhotos(bot, route, photos, result, retryAttempts);
        await sendDocuments(bot, route, documents, result, retryAttempts);

        result.ok = true;
        return asToolResponse(result);
      } catch (error) {
        const failure = toToolFailure(error);
        return failToolCall(result, failure.code, failure.message);
      }
    },
  } as ToolDefinition;
}

function createToolResult(route: TelegramRoute): ToolResultDetails {
  return {
    ok: false,
    route: {
      chat_id: route.chatId,
      ...(route.messageThreadId ? { message_thread_id: route.messageThreadId } : {}),
    },
    sent: {
      photo_groups: 0,
      photos: 0,
      documents: 0,
    },
    warnings: [],
    items: [],
  };
}

function partitionPreparedFiles(files: PreparedFile[]): { photos: PreparedFile[]; documents: PreparedFile[] } {
  const photos: PreparedFile[] = [];
  const documents: PreparedFile[] = [];

  for (const file of files) {
    if (file.kind === 'photo') {
      photos.push(file);
      continue;
    }

    documents.push(file);
  }

  return {
    photos,
    documents,
  };
}

function toToolFailure(error: unknown): { code: string; message: string } {
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: summarizeZodError(error),
    };
  }

  if (error instanceof ToolInputError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: 'telegram_send_failed',
    message: errorMessage(error),
  };
}

function summarizeZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return 'Invalid request payload.';
  }

  const path = firstIssue.path.length > 0 ? firstIssue.path.join('.') : 'payload';
  return `${path}: ${firstIssue.message}`;
}

function failToolCall(details: ToolResultDetails, code: string, message: string) {
  details.error_code = code;
  details.error_message = message;
  return asToolResponse(details);
}

function asToolResponse(details: ToolResultDetails) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(details, null, 2),
      },
    ],
    details,
  };
}
