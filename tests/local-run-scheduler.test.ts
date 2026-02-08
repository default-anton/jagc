import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import { LocalRunScheduler } from '../src/server/scheduler.js';
import type { RunRecord } from '../src/shared/run-types.js';

describe('LocalRunScheduler', () => {
  test('dispatches same-thread runs in enqueue order', async () => {
    const run1Started = deferred<void>();
    const releaseRun1 = deferred<void>();
    const dispatchOrder: string[] = [];

    const scheduler = new LocalRunScheduler({
      dispatchRunById: async (runId) => {
        dispatchOrder.push(runId);

        if (runId === 'run-1') {
          run1Started.resolve(undefined);
          await releaseRun1.promise;
        }
      },
    });

    await scheduler.start();
    await scheduler.enqueue(runRecord('run-1', 'thread:a'));
    await scheduler.enqueue(runRecord('run-2', 'thread:a'));

    await run1Started.promise;
    await sleep(10);
    expect(dispatchOrder).toEqual(['run-1']);

    releaseRun1.resolve(undefined);
    await waitUntil(() => dispatchOrder.length === 2);

    expect(dispatchOrder).toEqual(['run-1', 'run-2']);
    await scheduler.stop();
  });

  test('does not serialize dispatch across different threads', async () => {
    const run1Started = deferred<void>();
    const run2Started = deferred<void>();
    const releaseRun1 = deferred<void>();

    const scheduler = new LocalRunScheduler({
      dispatchRunById: async (runId) => {
        if (runId === 'run-1') {
          run1Started.resolve(undefined);
          await releaseRun1.promise;
          return;
        }

        if (runId === 'run-2') {
          run2Started.resolve(undefined);
        }
      },
    });

    await scheduler.start();
    await scheduler.enqueue(runRecord('run-1', 'thread:a'));
    await scheduler.enqueue(runRecord('run-2', 'thread:b'));

    await run1Started.promise;
    await run2Started.promise;

    releaseRun1.resolve(undefined);
    await scheduler.stop();
  });

  test('ensureEnqueued returns false when run is already scheduled', async () => {
    const releaseRun = deferred<void>();
    let executionCount = 0;

    const scheduler = new LocalRunScheduler({
      dispatchRunById: async () => {
        executionCount += 1;
        await releaseRun.promise;
      },
    });

    await scheduler.start();

    const run = runRecord('run-1', 'thread:a');
    await scheduler.enqueue(run);

    const ensured = await scheduler.ensureEnqueued(run);
    expect(ensured).toBe(false);

    releaseRun.resolve(undefined);
    await waitUntil(() => executionCount === 1);

    await scheduler.stop();
  });

  test('stop waits for active dispatches to settle', async () => {
    const dispatchStarted = deferred<void>();
    const releaseRun = deferred<void>();
    let completed = false;

    const scheduler = new LocalRunScheduler({
      dispatchRunById: async () => {
        dispatchStarted.resolve(undefined);
        await releaseRun.promise;
        completed = true;
      },
    });

    await scheduler.start();
    await scheduler.enqueue(runRecord('run-1', 'thread:a'));
    await dispatchStarted.promise;

    const stopPromise = scheduler.stop();
    await sleep(10);
    expect(completed).toBe(false);

    releaseRun.resolve(undefined);
    await stopPromise;

    expect(completed).toBe(true);
  });
});

function runRecord(runId: string, threadKey: string): RunRecord {
  const now = new Date().toISOString();

  return {
    runId,
    source: 'test',
    threadKey,
    userKey: null,
    deliveryMode: 'followUp',
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

async function waitUntil(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }

    await sleep(5);
  }
}
