import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import type { RunRecord } from '../shared/run-types.js';

export interface RunScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(run: RunRecord): Promise<void>;
  ensureEnqueued(run: RunRecord): Promise<boolean>;
}

type DispatchRunHandler = (runId: string) => Promise<void>;

interface LocalRunSchedulerOptions {
  dispatchRunById: DispatchRunHandler;
  logger?: Logger;
}

export class LocalRunScheduler implements RunScheduler {
  private started = false;
  private readonly scheduledRunIds = new Set<string>();
  private readonly activeDispatches = new Set<Promise<void>>();
  private readonly threadDispatchTails = new Map<string, Promise<void>>();
  private readonly logger: Logger;

  constructor(private readonly options: LocalRunSchedulerOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.activeDispatches.size === 0) {
      return;
    }

    await Promise.allSettled([...this.activeDispatches]);
  }

  async enqueue(run: RunRecord): Promise<void> {
    this.assertStarted();
    this.schedule(run);
  }

  async ensureEnqueued(run: RunRecord): Promise<boolean> {
    this.assertStarted();

    if (this.scheduledRunIds.has(run.runId)) {
      return false;
    }

    this.schedule(run);
    return true;
  }

  private schedule(run: RunRecord): void {
    if (this.scheduledRunIds.has(run.runId)) {
      return;
    }

    this.scheduledRunIds.add(run.runId);

    const threadTail = this.threadDispatchTails.get(run.threadKey) ?? Promise.resolve();

    const dispatch = threadTail
      .catch(() => {})
      .then(async () => {
        if (!this.started) {
          return;
        }

        try {
          await this.options.dispatchRunById(run.runId);
        } catch (error) {
          this.logger.error({
            event: 'run_scheduler_dispatch_failed',
            run_id: run.runId,
            error_message: toErrorMessage(error),
            err: toErrorForLog(error),
          });
        }
      })
      .finally(() => {
        this.scheduledRunIds.delete(run.runId);
        this.activeDispatches.delete(dispatch);

        if (this.threadDispatchTails.get(run.threadKey) === dispatch) {
          this.threadDispatchTails.delete(run.threadKey);
        }
      });

    this.threadDispatchTails.set(run.threadKey, dispatch);
    this.activeDispatches.add(dispatch);
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('run scheduler is not started');
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrorForLog(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}
