import type { Context } from 'grammy';
import type { Logger } from '../shared/logger.js';
import { telegramThreadKeyFromRoute } from '../shared/telegram-threading.js';
import { parseTelegramCallbackData } from './telegram-controls-callbacks.js';
import {
  helpText,
  type ParsedTelegramCommand,
  routeFromCallbackContext,
  routeFromMessageContext,
  userFacingError,
} from './telegram-polling-helpers.js';
import type { TelegramRuntimeControls } from './telegram-runtime-controls.js';

interface TelegramCommandDispatchOptions {
  ctx: Context;
  command: ParsedTelegramCommand;
  rawText: string;
  runtimeControls: TelegramRuntimeControls;
  logger: Logger;
  reply: (ctx: Context, text: string) => Promise<void>;
  handleAssistantMessage: (ctx: Context, text: string, deliveryMode: 'steer' | 'followUp') => Promise<void>;
  handleDeleteTopicCommand: (ctx: Context) => Promise<void>;
  onThreadCancelled: (ctx: Context) => void;
}

export async function dispatchTelegramCommand(options: TelegramCommandDispatchOptions): Promise<void> {
  const { ctx, command, rawText } = options;

  try {
    switch (command.command) {
      case 'start':
      case 'help': {
        await options.reply(ctx, helpText());
        return;
      }
      case 'settings': {
        await options.runtimeControls.handleSettingsCommand(ctx);
        return;
      }
      case 'cancel': {
        const cancelled = await options.runtimeControls.handleCancelCommand(ctx);
        if (cancelled && ctx.chat) {
          options.onThreadCancelled(ctx);
        }
        return;
      }
      case 'new': {
        await options.runtimeControls.handleNewCommand(ctx);
        return;
      }
      case 'delete': {
        await options.handleDeleteTopicCommand(ctx);
        return;
      }
      case 'share': {
        await options.runtimeControls.handleShareCommand(ctx);
        return;
      }
      case 'model': {
        await options.runtimeControls.handleModelCommand(ctx, command.args);
        return;
      }
      case 'thinking': {
        await options.runtimeControls.handleThinkingCommand(ctx, command.args);
        return;
      }
      case 'auth': {
        await options.runtimeControls.handleAuthCommand(ctx, command.args);
        return;
      }
      case 'steer': {
        await options.handleAssistantMessage(ctx, command.args.trim(), 'steer');
        return;
      }
      default: {
        await options.handleAssistantMessage(ctx, rawText, 'followUp');
        return;
      }
    }
  } catch (error) {
    const message = userFacingError(error);
    options.logger.error({
      event: 'telegram_command_failed',
      chat_id: ctx.chat?.id,
      thread_key: ctx.chat ? telegramThreadKeyFromRoute(routeFromMessageContext(ctx)) : null,
      command: command.command,
      message,
    });
    await options.reply(ctx, `❌ ${message}`);
  }
}

interface TelegramCallbackDispatchOptions {
  ctx: Context;
  runtimeControls: TelegramRuntimeControls;
  logger: Logger;
  reply: (ctx: Context, text: string) => Promise<void>;
}

export async function dispatchTelegramCallback(options: TelegramCallbackDispatchOptions): Promise<void> {
  const { ctx } = options;
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return;
  }

  const callbackRoute = routeFromCallbackContext(ctx);
  const action = parseTelegramCallbackData(data);
  if (!action) {
    try {
      await ctx.answerCallbackQuery({ text: 'This menu is outdated. Loading latest settings...' });
    } catch (error) {
      options.logger.warn({
        event: 'telegram_callback_query_ack_failed',
        chat_id: ctx.chat?.id,
        thread_key: telegramThreadKeyFromRoute(callbackRoute),
        callback_data: data,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await options.runtimeControls.handleStaleCallback(ctx);
    } catch (error) {
      const message = userFacingError(error);
      options.logger.error({
        event: 'telegram_callback_query_stale_recovery_failed',
        chat_id: ctx.chat?.id,
        thread_key: telegramThreadKeyFromRoute(callbackRoute),
        callback_data: data,
        message,
      });

      await options.reply(ctx, 'This menu is outdated. Use /settings to refresh.');
    }

    return;
  }

  const callbackLogContext = {
    chat_id: ctx.chat?.id,
    thread_key: telegramThreadKeyFromRoute(callbackRoute),
    callback_data: data,
    action_kind: action.kind,
  };

  try {
    await ctx.answerCallbackQuery();
  } catch (error) {
    options.logger.warn({
      event: 'telegram_callback_query_ack_failed',
      ...callbackLogContext,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await options.runtimeControls.handleCallbackAction(ctx, action);
    options.logger.info({ event: 'telegram_callback_query_handled', ...callbackLogContext });
  } catch (error) {
    const message = userFacingError(error);

    options.logger.error({
      event: 'telegram_callback_query_failed',
      ...callbackLogContext,
      message,
    });

    await options.reply(ctx, `❌ ${message}`);
  }
}
