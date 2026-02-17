import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import type { RunProgressEvent, RunProgressListener } from '../shared/run-progress.js';
import { isTerminalRunProgressEvent } from '../shared/run-progress.js';
import type { MessageIngest, RunRecord } from '../shared/run-types.js';
import type { RunExecutor } from './executor.js';
import type { RunScheduler } from './scheduler.js';
import type {
  CreateRunResult,
  PendingTelegramImageIngest,
  PendingTelegramImageIngestResult,
  RunStore,
} from './store.js';

const runProgressBufferSize = 256;
const runProgressTerminalRetentionMs = 5 * 60 * 1000;

interface RunProgressSubscriptionOptions {
  replay?: boolean;
}

interface ProgressAwareRunExecutor {
  setRunProgressListener?(listener: RunProgressListener | null): void;
}

export interface TelegramImageBufferRequest {
  threadKey: string;
  userKey: string;
  telegramUpdateId: number;
  images: PendingTelegramImageIngest['images'];
  telegramMediaGroupId?: string | null;
}

export class RunService {
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private readonly activeRunCompletions = new Map<string, Promise<void>>();
  private readonly runProgressListeners = new Map<string, Set<RunProgressListener>>();
  private readonly runProgressBuffers = new Map<string, RunProgressEvent[]>();
  private readonly runProgressCleanupTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly runStore: RunStore,
    private readonly runExecutor: RunExecutor,
    private readonly runScheduler: RunScheduler,
    private readonly logger: Logger = noopLogger,
  ) {
    const progressAwareExecutor = this.runExecutor as ProgressAwareRunExecutor;
    if (typeof progressAwareExecutor.setRunProgressListener === 'function') {
      progressAwareExecutor.setRunProgressListener((event) => {
        this.publishRunProgressEvent(event);
      });
    }
  }

  async init(): Promise<void> {
    await this.runStore.init();
    await this.runScheduler.start();
    await this.runRecoveryPass();

    this.recoveryTimer = setInterval(() => {
      void this.runRecoveryPass();
    }, 15_000);
  }

  async shutdown(): Promise<void> {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.recoveryInFlight) {
      await this.recoveryInFlight;
    }

    await this.runScheduler.stop();
    await this.waitForActiveRunCompletions();
    this.disposeRunProgressState();

    const progressAwareExecutor = this.runExecutor as ProgressAwareRunExecutor;
    if (typeof progressAwareExecutor.setRunProgressListener === 'function') {
      progressAwareExecutor.setRunProgressListener(null);
    }
  }

  async ingestMessage(message: MessageIngest): Promise<CreateRunResult> {
    const result = await this.runStore.createRun(message);

    if (!result.deduplicated) {
      this.publishRunProgressEvent({
        type: 'queued',
        runId: result.run.runId,
        threadKey: result.run.threadKey,
        source: result.run.source,
        deliveryMode: result.run.deliveryMode,
        timestamp: new Date().toISOString(),
      });
      await this.enqueueRun(result.run);
    }

    return result;
  }

  async bufferTelegramImages(request: TelegramImageBufferRequest): Promise<PendingTelegramImageIngestResult> {
    return this.runStore.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: request.threadKey,
      userKey: request.userKey,
      telegramUpdateId: request.telegramUpdateId,
      telegramMediaGroupId: request.telegramMediaGroupId,
      images: request.images,
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runStore.getRun(runId);
  }

  subscribeRunProgress(
    runId: string,
    listener: RunProgressListener,
    options: RunProgressSubscriptionOptions = {},
  ): () => void {
    const listeners = this.runProgressListeners.get(runId) ?? new Set<RunProgressListener>();
    listeners.add(listener);
    this.runProgressListeners.set(runId, listeners);

    if (options.replay !== false) {
      const bufferedEvents = this.runProgressBuffers.get(runId) ?? [];
      for (const event of bufferedEvents) {
        listener(event);
      }
    }

    return () => {
      const currentListeners = this.runProgressListeners.get(runId);
      if (!currentListeners) {
        return;
      }

      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        this.runProgressListeners.delete(runId);
      }
    };
  }

  async executeRunById(runId: string): Promise<void> {
    const run = await this.loadRunnableRun(runId);
    if (!run) {
      return;
    }

    await this.executeLoadedRun(run);
  }

  async dispatchRunById(runId: string): Promise<void> {
    const run = await this.loadRunnableRun(runId);
    if (!run) {
      return;
    }

    if (this.activeRunCompletions.has(run.runId)) {
      return;
    }

    const completion = this.executeLoadedRun(run)
      .catch((error) => {
        this.logger.error({
          event: 'run_dispatch_execute_failed',
          run_id: run.runId,
          error_message: toErrorMessage(error),
          err: toErrorForLog(error),
        });
      })
      .finally(() => {
        this.activeRunCompletions.delete(run.runId);
      });

    this.activeRunCompletions.set(run.runId, completion);
  }

  private async loadRunnableRun(runId: string): Promise<RunRecord | null> {
    const run = await this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`cannot execute run ${runId}: run not found`);
    }

    if (run.status !== 'running') {
      return null;
    }

    return run;
  }

  private async executeLoadedRun(run: RunRecord): Promise<void> {
    this.publishRunProgressEvent({
      type: 'started',
      runId: run.runId,
      threadKey: run.threadKey,
      source: run.source,
      deliveryMode: run.deliveryMode,
      timestamp: new Date().toISOString(),
    });

    try {
      const output = await this.runExecutor.execute(run);
      await this.runStore.markSucceeded(run.runId, output);
      this.publishRunProgressEvent({
        type: 'succeeded',
        runId: run.runId,
        threadKey: run.threadKey,
        source: run.source,
        deliveryMode: run.deliveryMode,
        output,
        timestamp: new Date().toISOString(),
      });
      return;
    } catch (error) {
      const failureMessage = toErrorMessage(error);

      try {
        await this.runStore.markFailed(run.runId, failureMessage);
        this.publishRunProgressEvent({
          type: 'failed',
          runId: run.runId,
          threadKey: run.threadKey,
          source: run.source,
          deliveryMode: run.deliveryMode,
          errorMessage: failureMessage,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (markFailedError) {
        if (isAlreadyTerminalTransition(markFailedError)) {
          return;
        }

        throw new Error(
          `run ${run.runId} failed with "${failureMessage}" and could not be marked failed: ${toErrorMessage(markFailedError)}`,
        );
      }
    }
  }

  private async runRecoveryPass(): Promise<void> {
    if (this.recoveryInFlight) {
      return this.recoveryInFlight;
    }

    this.recoveryInFlight = this.recoverRunningRuns().finally(() => {
      this.recoveryInFlight = null;
    });

    return this.recoveryInFlight;
  }

  private async recoverRunningRuns(): Promise<void> {
    const runningRuns = await this.runStore.listRunningRuns();

    for (const run of runningRuns) {
      if (this.activeRunCompletions.has(run.runId)) {
        continue;
      }

      try {
        await this.runScheduler.ensureEnqueued(run);
      } catch (error) {
        this.logger.error({
          event: 'run_recovery_enqueue_failed',
          run_id: run.runId,
          error_message: toErrorMessage(error),
          err: toErrorForLog(error),
        });
      }
    }
  }

  private async waitForActiveRunCompletions(): Promise<void> {
    if (this.activeRunCompletions.size === 0) {
      return;
    }

    await Promise.allSettled([...this.activeRunCompletions.values()]);
  }

  private async enqueueRun(run: RunRecord): Promise<void> {
    try {
      await this.runScheduler.enqueue(run);
    } catch (error) {
      this.logger.error({
        event: 'run_enqueue_failed',
        run_id: run.runId,
        error_message: toErrorMessage(error),
        err: toErrorForLog(error),
      });
      throw error;
    }
  }

  private publishRunProgressEvent(event: RunProgressEvent): void {
    const currentBuffer = this.runProgressBuffers.get(event.runId) ?? [];
    currentBuffer.push(event);

    if (currentBuffer.length > runProgressBufferSize) {
      currentBuffer.splice(0, currentBuffer.length - runProgressBufferSize);
    }

    this.runProgressBuffers.set(event.runId, currentBuffer);

    const listeners = this.runProgressListeners.get(event.runId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          this.logger.warn({
            event: 'run_progress_listener_failed',
            run_id: event.runId,
            error_message: toErrorMessage(error),
            err: toErrorForLog(error),
          });
        }
      }
    }

    if (!isTerminalRunProgressEvent(event)) {
      return;
    }

    const existingTimer = this.runProgressCleanupTimers.get(event.runId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const cleanupTimer = setTimeout(() => {
      this.runProgressCleanupTimers.delete(event.runId);
      this.runProgressBuffers.delete(event.runId);
      this.runProgressListeners.delete(event.runId);
    }, runProgressTerminalRetentionMs);

    this.runProgressCleanupTimers.set(event.runId, cleanupTimer);
  }

  private disposeRunProgressState(): void {
    for (const timer of this.runProgressCleanupTimers.values()) {
      clearTimeout(timer);
    }

    this.runProgressCleanupTimers.clear();
    this.runProgressBuffers.clear();
    this.runProgressListeners.clear();
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrorForLog(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}

function isAlreadyTerminalTransition(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('run is already');
}
