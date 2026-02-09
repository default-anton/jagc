import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { clampLimit, readPayload, toNumber, updateTypeAllowed } from './telegram-bot-api-clone-transport.js';

export interface TelegramCloneBotCall {
  method: string;
  payload: Record<string, unknown>;
}

interface PendingCallWaiter {
  method: string;
  predicate: (call: TelegramCloneBotCall) => boolean;
  resolve: (call: TelegramCloneBotCall) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface InjectTextMessageInput {
  chatId: number;
  fromId: number;
  text: string;
}

interface InjectCallbackQueryInput {
  chatId: number;
  fromId: number;
  data: string;
  messageId?: number;
  messageText?: string;
}

interface GetUpdatesArgs {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface TelegramBotApiCloneOptions {
  token: string;
  username?: string;
}

export class TelegramBotApiClone {
  private readonly token: string;
  private readonly username: string;
  private readonly server: Server;
  private readonly updates: Array<Record<string, unknown>> = [];
  private readonly updateWaiters = new Set<() => void>();
  private readonly botCalls: TelegramCloneBotCall[] = [];
  private readonly pendingCallWaiters = new Set<PendingCallWaiter>();
  private nextUpdateId = 1;
  private nextMessageId = 1;
  private nextCallbackQueryId = 1;

  apiRoot: string | null = null;

  constructor(options: TelegramBotApiCloneOptions) {
    this.token = options.token;
    this.username = options.username ?? 'jagc_test_bot';
    this.server = createServer(async (request, response) => {
      await this.handleRequest(request, response);
    });
  }

  async start(): Promise<void> {
    if (this.apiRoot) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to bind telegram clone server');
    }

    this.apiRoot = `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.notifyUpdateWaiters();

    for (const waiter of this.pendingCallWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('telegram clone stopped before expected bot call'));
      this.pendingCallWaiters.delete(waiter);
    }

    if (!this.apiRoot) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.apiRoot = null;
  }

  injectTextMessage(input: InjectTextMessageInput): number {
    const updateId = this.nextUpdateId++;
    const update = {
      update_id: updateId,
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: input.chatId,
          type: 'private',
        },
        from: {
          id: input.fromId,
          is_bot: false,
          first_name: 'Tester',
        },
        text: input.text,
      },
    };

    this.updates.push(update);
    this.notifyUpdateWaiters();
    return updateId;
  }

  injectCallbackQuery(input: InjectCallbackQueryInput): number {
    const updateId = this.nextUpdateId++;
    const callbackId = `cq-${this.nextCallbackQueryId++}`;
    const messageId = input.messageId ?? this.nextMessageId++;
    const update = {
      update_id: updateId,
      callback_query: {
        id: callbackId,
        from: {
          id: input.fromId,
          is_bot: false,
          first_name: 'Tester',
        },
        chat_instance: `chat-${input.chatId}`,
        data: input.data,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: input.chatId,
            type: 'private',
          },
          text: input.messageText ?? 'menu',
        },
      },
    };

    this.updates.push(update);
    this.notifyUpdateWaiters();
    return updateId;
  }

  getBotCalls(): TelegramCloneBotCall[] {
    return [...this.botCalls];
  }

  async waitForBotCall(
    method: string,
    predicate: (call: TelegramCloneBotCall) => boolean = () => true,
    timeoutMs = 3_000,
  ): Promise<TelegramCloneBotCall> {
    const existingCall = this.botCalls.find((call) => call.method === method && predicate(call));
    if (existingCall) {
      return existingCall;
    }

    return new Promise<TelegramCloneBotCall>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCallWaiters.delete(waiter);
        reject(new Error(`timed out waiting for bot call ${method}`));
      }, timeoutMs);

      const waiter: PendingCallWaiter = {
        method,
        predicate,
        resolve: (call) => {
          clearTimeout(timeout);
          resolve(call);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };

      this.pendingCallWaiters.add(waiter);
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method;
    const url = request.url;
    if (method !== 'POST' || !url) {
      this.writeJson(response, 404, {
        ok: false,
        error_code: 404,
        description: 'Not Found',
      });
      return;
    }

    const match = url.match(/^\/bot([^/]+)\/([^/?]+)$/);
    if (!match) {
      this.writeJson(response, 404, {
        ok: false,
        error_code: 404,
        description: 'Not Found',
      });
      return;
    }

    const token = decodeURIComponent(match[1] ?? '');
    const methodName = decodeURIComponent(match[2] ?? '');
    if (token !== this.token) {
      this.writeJson(response, 401, {
        ok: false,
        error_code: 401,
        description: 'Unauthorized',
      });
      return;
    }

    const payload = await readPayload(request);

    try {
      const result = await this.handleMethodCall(methodName, payload);
      this.writeJson(response, 200, {
        ok: true,
        result,
      });
    } catch (error) {
      this.writeJson(response, 500, {
        ok: false,
        error_code: 500,
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMethodCall(method: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getMe': {
        return {
          id: 777000,
          is_bot: true,
          first_name: 'jagc',
          username: this.username,
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        };
      }
      case 'getUpdates': {
        return this.getUpdates(payload as unknown as GetUpdatesArgs);
      }
      case 'sendMessage': {
        this.recordBotCall({ method, payload });

        const chatId = toNumber(payload.chat_id) ?? 0;
        const text = typeof payload.text === 'string' ? payload.text : '';

        return {
          message_id: this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: 'private',
          },
          text,
        };
      }
      case 'editMessageText': {
        this.recordBotCall({ method, payload });

        const chatId = toNumber(payload.chat_id) ?? 0;
        const messageId = toNumber(payload.message_id) ?? 0;
        const text = typeof payload.text === 'string' ? payload.text : '';

        return {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: 'private',
          },
          text,
        };
      }
      case 'answerCallbackQuery': {
        this.recordBotCall({ method, payload });
        return true;
      }
      default: {
        throw new Error(`unsupported telegram method: ${method}`);
      }
    }
  }

  private async getUpdates(args: GetUpdatesArgs): Promise<Array<Record<string, unknown>>> {
    this.discardAcknowledgedUpdates(args.offset);

    const limit = clampLimit(args.limit);
    const timeoutMs = Math.max(0, Math.floor((args.timeout ?? 0) * 1000));
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const available = this.selectAvailableUpdates(args.allowed_updates, limit);
      if (available.length > 0) {
        return available;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return [];
      }

      await this.waitForUpdate(Math.min(remainingMs, 200));
      this.discardAcknowledgedUpdates(args.offset);
    }
  }

  private discardAcknowledgedUpdates(offset: number | undefined): void {
    if (offset === undefined) {
      return;
    }

    while (this.updates.length > 0) {
      const head = this.updates[0];
      const updateId = typeof head?.update_id === 'number' ? head.update_id : null;
      if (updateId === null || updateId >= offset) {
        return;
      }

      this.updates.shift();
    }
  }

  private selectAvailableUpdates(allowedUpdates: string[] | undefined, limit: number): Array<Record<string, unknown>> {
    const selected: Array<Record<string, unknown>> = [];

    for (const update of this.updates) {
      if (!updateTypeAllowed(update, allowedUpdates)) {
        continue;
      }

      selected.push(update);
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  private async waitForUpdate(timeoutMs: number): Promise<void> {
    let waiter: (() => void) | null = null;
    const updatePromise = new Promise<void>((resolve) => {
      waiter = () => {
        if (waiter) {
          this.updateWaiters.delete(waiter);
        }

        resolve();
      };

      this.updateWaiters.add(waiter);
    });

    try {
      await Promise.race([updatePromise, sleep(timeoutMs)]);
    } finally {
      if (waiter) {
        this.updateWaiters.delete(waiter);
      }
    }
  }

  private notifyUpdateWaiters(): void {
    const waiters = [...this.updateWaiters];
    this.updateWaiters.clear();

    for (const resolve of waiters) {
      resolve();
    }
  }

  private recordBotCall(call: TelegramCloneBotCall): void {
    this.botCalls.push(call);

    for (const waiter of [...this.pendingCallWaiters]) {
      if (waiter.method !== call.method) {
        continue;
      }

      if (!waiter.predicate(call)) {
        continue;
      }

      this.pendingCallWaiters.delete(waiter);
      waiter.resolve(call);
    }
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }
}
