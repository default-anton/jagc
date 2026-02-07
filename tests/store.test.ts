import { describe, expect, test } from 'vitest';

import { InMemoryRunStore } from '../src/server/store.js';

describe('InMemoryRunStore', () => {
  test('markFailed rejects when run is already succeeded', async () => {
    const store = new InMemoryRunStore();
    await store.init();

    const created = await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'hello',
      deliveryMode: 'followUp',
    });

    await store.markSucceeded(created.run.runId, { type: 'message', text: 'hello' });

    await expect(store.markFailed(created.run.runId, 'boom')).rejects.toThrow(
      `cannot mark run ${created.run.runId} as failed: run is already succeeded`,
    );
  });

  test('markSucceeded rejects when run is missing', async () => {
    const store = new InMemoryRunStore();
    await store.init();

    await expect(store.markSucceeded('missing-run-id', { type: 'message', text: 'hello' })).rejects.toThrow(
      'cannot mark run missing-run-id as succeeded: run not found',
    );
  });

  test('listRunningRuns returns only running runs', async () => {
    const store = new InMemoryRunStore();
    await store.init();

    const first = await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'first',
      deliveryMode: 'followUp',
    });

    const second = await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'second',
      deliveryMode: 'followUp',
    });

    await store.markSucceeded(first.run.runId, { type: 'message', text: 'first' });

    const running = await store.listRunningRuns();
    expect(running.map((run) => run.runId)).toEqual([second.run.runId]);
  });

  test('persists thread session mapping', async () => {
    const store = new InMemoryRunStore();
    await store.init();

    await store.upsertThreadSession('cli:default', 'session-1', '/tmp/session-1.jsonl');

    const record = await store.getThreadSession('cli:default');
    expect(record).toMatchObject({
      threadKey: 'cli:default',
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
    });
  });
});
