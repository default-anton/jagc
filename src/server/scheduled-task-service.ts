import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import { telegramThreadKeyFromRoute } from '../shared/telegram-threading.js';
import {
  buildTaskRunInstructions,
  deliveryTargetFromCreatorThread,
  idempotencyKeyForTaskOccurrence,
  parseCreatorTelegramTopicThreadId,
  parseTelegramTaskRoute,
  sanitizeThreadPrefix,
  toErrorMessage,
} from './scheduled-task-helpers.js';
import {
  computeInitialNextRunAt,
  computeNextRunAfterOccurrence,
  normalizeIsoUtcTimestamp,
  normalizeRRuleExpression,
  validateScheduleInput,
} from './scheduled-task-schedule.js';
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskRunNowResult,
  ScheduledTaskServiceOptions,
  ScheduledTaskUpdateInput,
  ScheduledTaskUpdateResult,
} from './scheduled-task-service-types.js';
import type { ScheduledTaskStore } from './scheduled-task-store.js';
import type {
  ScheduledTaskDeliveryTarget,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskScheduleKind,
  UpdateScheduledTaskInput,
} from './scheduled-task-types.js';
import type { RunService } from './service.js';

const defaultPollIntervalMs = 5_000;
const defaultDueBatchSize = 20;
const defaultRecoveryBatchSize = 200;

export class ScheduledTaskService {
  private readonly pollIntervalMs: number;
  private readonly dueBatchSize: number;
  private readonly recoveryBatchSize: number;
  private readonly logger: Logger;

  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly runService: RunService,
    private readonly options: ScheduledTaskServiceOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.dueBatchSize = options.dueBatchSize ?? defaultDueBatchSize;
    this.recoveryBatchSize = options.recoveryBatchSize ?? defaultRecoveryBatchSize;
    this.logger = options.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await this.store.init();
    await this.runTick();

    this.timer = setInterval(() => {
      void this.runTick();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.tickInFlight) {
      await this.tickInFlight;
    }
  }

  async createTask(input: ScheduledTaskCreateInput): Promise<ScheduledTaskRecord> {
    const now = new Date();
    const scheduleOnceAt =
      input.schedule.kind === 'once'
        ? (normalizeIsoUtcTimestamp(input.schedule.onceAt) ?? input.schedule.onceAt)
        : undefined;
    const scheduleCronExpr = input.schedule.kind === 'cron' ? input.schedule.cronExpr : undefined;
    const scheduleRRuleExpr =
      input.schedule.kind === 'rrule'
        ? normalizeRRuleExpression(input.schedule.rruleExpr, input.schedule.timezone, now)
        : undefined;

    validateScheduleInput({
      kind: input.schedule.kind,
      onceAt: scheduleOnceAt,
      cronExpr: scheduleCronExpr,
      rruleExpr: scheduleRRuleExpr,
      timezone: input.schedule.timezone,
    });

    const nextRunAt = computeInitialNextRunAt({
      kind: input.schedule.kind,
      onceAt: scheduleOnceAt,
      cronExpr: scheduleCronExpr,
      rruleExpr: scheduleRRuleExpr,
      timezone: input.schedule.timezone,
      now,
    });

    return this.store.createTask({
      title: input.title,
      instructions: input.instructions,
      scheduleKind: input.schedule.kind,
      onceAt: input.schedule.kind === 'once' ? (scheduleOnceAt ?? null) : null,
      cronExpr: input.schedule.kind === 'cron' ? input.schedule.cronExpr : null,
      rruleExpr: input.schedule.kind === 'rrule' ? (scheduleRRuleExpr ?? null) : null,
      timezone: input.schedule.timezone,
      enabled: true,
      nextRunAt,
      creatorThreadKey: input.creatorThreadKey,
      ownerUserKey: input.ownerUserKey ?? null,
      deliveryTarget: deliveryTargetFromCreatorThread(input.creatorThreadKey),
    });
  }

  async listTasks(
    filter: { creatorThreadKey?: string; state?: 'all' | 'enabled' | 'disabled' } = {},
  ): Promise<ScheduledTaskRecord[]> {
    return this.store.listTasks({
      creatorThreadKey: filter.creatorThreadKey,
      enabled: filter.state === 'enabled' ? true : filter.state === 'disabled' ? false : undefined,
    });
  }

  async getTask(taskId: string): Promise<ScheduledTaskRecord | null> {
    return this.store.getTask(taskId);
  }

  async updateTask(taskId: string, input: ScheduledTaskUpdateInput): Promise<ScheduledTaskUpdateResult | null> {
    const existing = await this.store.getTask(taskId);
    if (!existing) {
      return null;
    }

    const warnings: string[] = [];
    const now = new Date();

    let scheduleKind: ScheduledTaskScheduleKind = existing.scheduleKind;
    let onceAt = existing.onceAt;
    let cronExpr = existing.cronExpr;
    let rruleExpr = existing.rruleExpr;
    let timezone = existing.timezone;

    if (input.schedule) {
      scheduleKind = input.schedule.kind;
      onceAt =
        input.schedule.kind === 'once'
          ? (normalizeIsoUtcTimestamp(input.schedule.onceAt) ?? input.schedule.onceAt)
          : null;
      cronExpr = input.schedule.kind === 'cron' ? input.schedule.cronExpr : null;
      rruleExpr =
        input.schedule.kind === 'rrule'
          ? normalizeRRuleExpression(input.schedule.rruleExpr, input.schedule.timezone, now)
          : null;
      timezone = input.schedule.timezone;

      validateScheduleInput({
        kind: scheduleKind,
        onceAt: onceAt ?? undefined,
        cronExpr: cronExpr ?? undefined,
        rruleExpr: rruleExpr ?? undefined,
        timezone,
      });
    }

    const enabled = input.enabled ?? existing.enabled;
    const scheduleChanged =
      input.schedule !== undefined ||
      scheduleKind !== existing.scheduleKind ||
      onceAt !== existing.onceAt ||
      cronExpr !== existing.cronExpr ||
      rruleExpr !== existing.rruleExpr ||
      timezone !== existing.timezone;

    let nextRunAt = existing.nextRunAt;
    if (!enabled) {
      nextRunAt = null;
    } else if (!existing.enabled || scheduleChanged) {
      nextRunAt = computeInitialNextRunAt({
        kind: scheduleKind,
        onceAt: onceAt ?? undefined,
        cronExpr: cronExpr ?? undefined,
        rruleExpr: rruleExpr ?? undefined,
        timezone,
        now,
      });
    }

    const updated = await this.store.updateTask(taskId, {
      title: input.title,
      instructions: input.instructions,
      scheduleKind,
      onceAt,
      cronExpr,
      rruleExpr,
      timezone,
      enabled,
      nextRunAt,
    } as UpdateScheduledTaskInput);

    if (!updated) {
      return null;
    }

    if (input.title && input.title !== existing.title && updated.executionThreadKey) {
      const maybeWarning = await this.syncTaskExecutionTitleBestEffort(updated);
      if (maybeWarning) {
        warnings.push(maybeWarning);
      }
    }

    return {
      task: updated,
      warnings,
    };
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.store.deleteTask(taskId);
  }

  async runNow(taskId: string): Promise<ScheduledTaskRunNowResult | null> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      return null;
    }

    const scheduledFor = new Date().toISOString();
    const taskRun = await this.store.createOrGetTaskRun(
      task.taskId,
      scheduledFor,
      idempotencyKeyForTaskOccurrence(task.taskId, scheduledFor),
    );

    let executionTask = task;
    try {
      executionTask = await this.ensureExecutionThread(task);
    } catch (error) {
      await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', toErrorMessage(error));
      throw error;
    }

    await this.dispatchTaskRun(executionTask, taskRun);

    const refreshedTask = (await this.store.getTask(task.taskId)) ?? executionTask;
    const refreshedTaskRun = (await this.store.getTaskRun(taskRun.taskRunId)) ?? taskRun;

    return {
      task: refreshedTask,
      taskRun: refreshedTaskRun,
    };
  }

  private async runTick(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.tickInFlight) {
      return this.tickInFlight;
    }

    this.tickInFlight = (async () => {
      try {
        await this.processDueTasks();
        await this.resumePendingTaskRuns();
        await this.reconcileDispatchedTaskRuns();
      } finally {
        this.tickInFlight = null;
      }
    })();

    return this.tickInFlight;
  }

  private async processDueTasks(): Promise<void> {
    const dueTasks = await this.store.listDueTasks(new Date().toISOString(), this.dueBatchSize);

    for (const task of dueTasks) {
      const scheduledFor = task.nextRunAt;
      if (!scheduledFor) {
        continue;
      }

      const taskRun = await this.store.createOrGetTaskRun(
        task.taskId,
        scheduledFor,
        idempotencyKeyForTaskOccurrence(task.taskId, scheduledFor),
      );

      const scheduleAdvance = computeNextRunAfterOccurrence({
        kind: task.scheduleKind,
        cronExpr: task.cronExpr ?? undefined,
        rruleExpr: task.rruleExpr ?? undefined,
        timezone: task.timezone,
        now: new Date(),
      });

      await this.store.advanceTaskAfterOccurrence(
        task.taskId,
        scheduledFor,
        scheduleAdvance.enabled,
        scheduleAdvance.nextRunAt,
      );

      let executionTask = task;
      try {
        executionTask = await this.ensureExecutionThread(task);
      } catch (error) {
        const failureMessage = toErrorMessage(error);
        await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', failureMessage);

        this.logger.warn({
          event: 'scheduled_task_execution_thread_ensure_failed',
          task_id: task.taskId,
          task_run_id: taskRun.taskRunId,
          error_message: failureMessage,
        });

        continue;
      }

      if (taskRun.status === 'pending') {
        await this.dispatchTaskRun(executionTask, taskRun);
      }
    }
  }

  private async resumePendingTaskRuns(): Promise<void> {
    const pendingRuns = await this.store.listTaskRunsByStatuses(['pending'], this.recoveryBatchSize);

    for (const taskRun of pendingRuns) {
      const task = await this.store.getTask(taskRun.taskId);
      if (!task) {
        continue;
      }

      let executionTask = task;
      try {
        executionTask = await this.ensureExecutionThread(task);
      } catch (error) {
        await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', toErrorMessage(error));
        continue;
      }

      await this.dispatchTaskRun(executionTask, taskRun);
    }
  }

  private async reconcileDispatchedTaskRuns(): Promise<void> {
    const dispatchedRuns = await this.store.listTaskRunsByStatuses(['dispatched'], this.recoveryBatchSize);

    for (const taskRun of dispatchedRuns) {
      if (!taskRun.runId) {
        await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', 'task run missing run_id');
        continue;
      }

      const run = await this.runService.getRun(taskRun.runId);
      if (!run) {
        await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', `run ${taskRun.runId} not found`);
        continue;
      }

      if (run.status === 'running') {
        const task = await this.store.getTask(taskRun.taskId);
        if (task) {
          await this.deliverRunBestEffort(task, run.runId);
        }
        continue;
      }

      if (run.status === 'succeeded') {
        await this.store.markTaskRunTerminal(taskRun.taskRunId, 'succeeded', null);
        continue;
      }

      await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', run.errorMessage ?? 'run failed');
    }
  }

  private async dispatchTaskRun(task: ScheduledTaskRecord, taskRun: ScheduledTaskRunRecord): Promise<void> {
    if (task.executionThreadKey === null) {
      await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', 'task execution thread is not available');
      return;
    }

    const instructions = buildTaskRunInstructions(task, taskRun.scheduledFor);

    const ingested = await this.runService.ingestMessage({
      source: `task:${task.taskId}`,
      threadKey: task.executionThreadKey,
      userKey: task.ownerUserKey ?? undefined,
      text: instructions,
      deliveryMode: 'followUp',
      idempotencyKey: taskRun.idempotencyKey,
    });

    if (ingested.run.status === 'running') {
      await this.store.markTaskRunDispatched(taskRun.taskRunId, ingested.run.runId);
      await this.deliverRunBestEffort(task, ingested.run.runId);
      return;
    }

    if (ingested.run.status === 'succeeded') {
      await this.store.markTaskRunTerminal(taskRun.taskRunId, 'succeeded', null);
      return;
    }

    await this.store.markTaskRunTerminal(taskRun.taskRunId, 'failed', ingested.run.errorMessage ?? 'run failed');
  }

  private async ensureExecutionThread(task: ScheduledTaskRecord): Promise<ScheduledTaskRecord> {
    if (task.executionThreadKey) {
      return task;
    }

    const provider = task.deliveryTarget.provider;

    if (provider === 'telegram') {
      const route = parseTelegramTaskRoute(task.deliveryTarget);
      if (!route) {
        throw new Error(
          'telegram_topics_unavailable: this task requires Telegram topics; enable topic mode for this chat and retry',
        );
      }

      const telegramBridge = this.options.telegramBridge;
      if (!telegramBridge) {
        throw new Error(
          'telegram_topics_unavailable: this task requires Telegram topics; enable topic mode for this chat and retry',
        );
      }

      const topicRoute = await telegramBridge.createTaskTopic({
        chatId: route.chatId,
        taskId: task.taskId,
        title: task.title,
      });

      const updatedTarget: ScheduledTaskDeliveryTarget = {
        ...task.deliveryTarget,
        route: {
          ...task.deliveryTarget.route,
          chatId: topicRoute.chatId,
          messageThreadId: topicRoute.messageThreadId,
        },
      };

      const executionThreadKey = telegramThreadKeyFromRoute(topicRoute);
      await this.store.setTaskExecutionThread(task.taskId, executionThreadKey, updatedTarget);

      const refreshed = await this.store.getTask(task.taskId);
      if (!refreshed) {
        throw new Error(`task ${task.taskId} disappeared while creating execution thread`);
      }

      return refreshed;
    }

    const defaultThreadPrefix = sanitizeThreadPrefix(provider);
    const executionThreadKey = `${defaultThreadPrefix}:task:${task.taskId}`;
    await this.store.setTaskExecutionThread(task.taskId, executionThreadKey, task.deliveryTarget);

    const refreshed = await this.store.getTask(task.taskId);
    if (!refreshed) {
      throw new Error(`task ${task.taskId} disappeared while creating execution thread`);
    }

    return refreshed;
  }

  private async syncTaskExecutionTitleBestEffort(task: ScheduledTaskRecord): Promise<string | null> {
    if (task.deliveryTarget.provider !== 'telegram') {
      return null;
    }

    const route = parseTelegramTaskRoute(task.deliveryTarget);
    if (!route?.messageThreadId) {
      return null;
    }

    const creatorTopicThreadId = parseCreatorTelegramTopicThreadId(task.deliveryTarget);
    if (creatorTopicThreadId && creatorTopicThreadId === route.messageThreadId) {
      return null;
    }

    const telegramBridge = this.options.telegramBridge;
    if (!telegramBridge) {
      return 'execution thread title was not synced because Telegram integration is unavailable';
    }

    try {
      await telegramBridge.syncTaskTopicTitle(route, task.taskId, task.title);
      return null;
    } catch (error) {
      return `execution thread title sync failed: ${toErrorMessage(error)}`;
    }
  }

  private async deliverRunBestEffort(task: ScheduledTaskRecord, runId: string): Promise<void> {
    if (task.deliveryTarget.provider !== 'telegram') {
      return;
    }

    const route = parseTelegramTaskRoute(task.deliveryTarget);
    if (!route?.messageThreadId) {
      return;
    }

    const telegramBridge = this.options.telegramBridge;
    if (!telegramBridge) {
      return;
    }

    try {
      await telegramBridge.deliverRun(runId, route);
    } catch (error) {
      this.logger.warn({
        event: 'scheduled_task_telegram_delivery_failed',
        task_id: task.taskId,
        run_id: runId,
        error_message: toErrorMessage(error),
      });
    }
  }
}

export type {
  ScheduledTaskCreateInput,
  ScheduledTaskRunNowResult,
  ScheduledTaskUpdateInput,
  ScheduledTaskUpdateResult,
};
