import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import type { RunExecutor } from '../src/server/executor.js';
import { LocalRunScheduler } from '../src/server/scheduler.js';
import { RunService } from '../src/server/service.js';
import type { RunStore, ThreadSessionRecord } from '../src/server/store.js';
import type { DeliveryMode, MessageIngest, RunOutput, RunRecord } from '../src/shared/run-types.js';

describe('RunService + LocalRunScheduler integration', () => {
  test('preserves same-thread run dispatch order even when first run load is slower', async () => {
    const releaseRun1 = deferred<void>();
    const run1Started = deferred<void>();
    const run2Started = deferred<void>();
    const executionOrder: string[] = [];

    const run1 = runRecord('run-1', 'thread:a');
    const run2 = runRecord('run-2', 'thread:a');

    const runStore = new InMemoryRunStore([run1, run2], {
      getRunDelayMsByRunId: {
        'run-1': 30,
      },
    });

    const runExecutor: RunExecutor = {
      async execute(run): Promise<RunOutput> {
        executionOrder.push(run.runId);

        if (run.runId === 'run-1') {
          run1Started.resolve(undefined);
          await releaseRun1.promise;
        }

        if (run.runId === 'run-2') {
          run2Started.resolve(undefined);
        }

        return {
          type: 'message',
          text: run.runId,
          delivery_mode: run.deliveryMode,
        };
      },
    };

    let runService: RunService | undefined;
    const runScheduler = new LocalRunScheduler({
      dispatchRunById: async (runId) => {
        if (!runService) {
          throw new Error('run service not initialized');
        }

        await runService.dispatchRunById(runId);
      },
    });

    runService = new RunService(runStore, runExecutor, runScheduler);
    await runService.init();

    await runScheduler.enqueue(run1);
    await runScheduler.enqueue(run2);

    await run1Started.promise;
    await run2Started.promise;

    expect(executionOrder).toEqual(['run-1', 'run-2']);

    releaseRun1.resolve(undefined);
    await runService.shutdown();
  });

  test('shutdown waits for in-flight run completion launched by dispatch', async () => {
    const releaseRun = deferred<void>();
    let completed = false;

    const run = runRecord('run-1', 'thread:a');
    const runStore = new InMemoryRunStore([run]);

    const runExecutor: RunExecutor = {
      async execute(inputRun): Promise<RunOutput> {
        await releaseRun.promise;
        completed = true;

        return {
          type: 'message',
          text: inputRun.runId,
          delivery_mode: inputRun.deliveryMode,
        };
      },
    };

    let runService: RunService | undefined;
    const runScheduler = new LocalRunScheduler({
      dispatchRunById: async (runId) => {
        if (!runService) {
          throw new Error('run service not initialized');
        }

        await runService.dispatchRunById(runId);
      },
    });

    runService = new RunService(runStore, runExecutor, runScheduler);
    await runService.init();

    await runScheduler.enqueue(run);

    const shutdownPromise = runService.shutdown();
    await sleep(10);
    expect(completed).toBe(false);

    releaseRun.resolve(undefined);
    await shutdownPromise;

    expect(completed).toBe(true);
  });
});

class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    initialRuns: RunRecord[],
    private readonly options: {
      getRunDelayMsByRunId?: Record<string, number>;
    } = {},
  ) {
    for (const run of initialRuns) {
      this.runs.set(run.runId, run);
    }
  }

  async init(): Promise<void> {}

  async createRun(_message: MessageIngest): Promise<{ run: RunRecord; deduplicated: boolean }> {
    throw new Error('not implemented for this test');
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const delayMs = this.options.getRunDelayMsByRunId?.[runId];
    if (delayMs) {
      await sleep(delayMs);
    }

    return this.runs.get(runId) ?? null;
  }

  async listRunningRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((run) => run.status === 'running');
  }

  async markSucceeded(runId: string, output: RunOutput): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run ${runId} not found`);
    }

    if (run.status !== 'running') {
      throw new Error(`cannot mark run ${runId} as succeeded: run is already ${run.status}`);
    }

    this.runs.set(runId, {
      ...run,
      status: 'succeeded',
      output,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    });
  }

  async markFailed(runId: string, errorMessage: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run ${runId} not found`);
    }

    if (run.status !== 'running') {
      throw new Error(`cannot mark run ${runId} as failed: run is already ${run.status}`);
    }

    this.runs.set(runId, {
      ...run,
      status: 'failed',
      output: null,
      errorMessage,
      updatedAt: new Date().toISOString(),
    });
  }

  async getThreadSession(_threadKey: string): Promise<ThreadSessionRecord | null> {
    return null;
  }

  async upsertThreadSession(
    _threadKey: string,
    _sessionId: string,
    _sessionFile: string,
  ): Promise<ThreadSessionRecord> {
    throw new Error('not implemented for this test');
  }

  async deleteThreadSession(_threadKey: string): Promise<void> {}
}

function runRecord(runId: string, threadKey: string, deliveryMode: DeliveryMode = 'followUp'): RunRecord {
  const now = new Date().toISOString();

  return {
    runId,
    source: 'test',
    threadKey,
    userKey: null,
    deliveryMode,
    status: 'running',
    inputText: runId,
    output: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
