import type { Logger } from '../shared/logger.js';
import type { TelegramRoute } from '../shared/telegram-threading.js';
import type { ScheduledTaskRecord, ScheduledTaskRunRecord } from './scheduled-task-types.js';

export interface ScheduledTaskServiceOptions {
  pollIntervalMs?: number;
  dueBatchSize?: number;
  recoveryBatchSize?: number;
  logger?: Logger;
  telegramBridge?: {
    createTaskTopic(route: { chatId: number; taskId: string; title: string }): Promise<TelegramRoute>;
    syncTaskTopicTitle(route: TelegramRoute, taskId: string, title: string): Promise<void>;
    deliverRun(runId: string, route: TelegramRoute): Promise<void>;
  };
}

export interface ScheduledTaskCreateInput {
  creatorThreadKey: string;
  ownerUserKey?: string | null;
  title: string;
  instructions: string;
  schedule:
    | {
        kind: 'once';
        onceAt: string;
        timezone: string;
      }
    | {
        kind: 'cron';
        cronExpr: string;
        timezone: string;
      };
}

export interface ScheduledTaskUpdateInput {
  title?: string;
  instructions?: string;
  enabled?: boolean;
  schedule?:
    | {
        kind: 'once';
        onceAt: string;
        timezone: string;
      }
    | {
        kind: 'cron';
        cronExpr: string;
        timezone: string;
      };
}

export interface ScheduledTaskRunNowResult {
  task: ScheduledTaskRecord;
  taskRun: ScheduledTaskRunRecord;
}

export interface ScheduledTaskUpdateResult {
  task: ScheduledTaskRecord;
  warnings: string[];
}
