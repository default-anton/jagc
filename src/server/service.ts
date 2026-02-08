import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import type { MessageIngest, RunRecord } from '../shared/run-types.js';
import type { RunExecutor } from './executor.js';
import type { RunScheduler } from './scheduler.js';
import type { CreateRunResult, RunStore } from './store.js';

export class RunService {
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private readonly activeRunCompletions = new Map<string, Promise<void>>();

  constructor(
    private readonly runStore: RunStore,
    private readonly runExecutor: RunExecutor,
    private readonly runScheduler: RunScheduler,
    private readonly logger: Logger = noopLogger,
  ) {}

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
  }

  async ingestMessage(message: MessageIngest): Promise<CreateRunResult> {
    const result = await this.runStore.createRun(message);

    if (!result.deduplicated) {
      await this.enqueueRun(result.run);
    }

    return result;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runStore.getRun(runId);
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
          message: toErrorMessage(error),
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
    try {
      const output = await this.runExecutor.execute(run);
      await this.runStore.markSucceeded(run.runId, output);
      return;
    } catch (error) {
      const failureMessage = toErrorMessage(error);

      try {
        await this.runStore.markFailed(run.runId, failureMessage);
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
          message: toErrorMessage(error),
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
        message: toErrorMessage(error),
      });
      throw error;
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyTerminalTransition(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('run is already');
}
