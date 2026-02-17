import { describe, expect, test } from 'vitest';

import { IdempotencyPayloadMismatchError, SqliteRunStore } from '../src/server/store.js';
import { useSqliteTestDb } from './helpers/sqlite-test-db.js';

const testDb = useSqliteTestDb();

describe('SqliteRunStore', () => {
  test('markFailed rejects when run is already succeeded', async () => {
    const store = new SqliteRunStore(testDb.database);
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
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await expect(store.markSucceeded('missing-run-id', { type: 'message', text: 'hello' })).rejects.toThrow(
      'cannot mark run missing-run-id as succeeded: run not found',
    );
  });

  test('listRunningRuns returns only running runs', async () => {
    const store = new SqliteRunStore(testDb.database);
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
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await store.upsertThreadSession('cli:default', 'session-1', '/tmp/session-1.jsonl');

    const record = await store.getThreadSession('cli:default');
    expect(record).toMatchObject({
      threadKey: 'cli:default',
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
    });
  });

  test('deletes persisted thread session mapping', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await store.upsertThreadSession('cli:default', 'session-1', '/tmp/session-1.jsonl');
    await store.deleteThreadSession('cli:default');

    const record = await store.getThreadSession('cli:default');
    expect(record).toBeNull();
  });

  test('persists and deletes run-linked input images in request order', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    const created = await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'describe images',
      deliveryMode: 'followUp',
      images: [
        {
          mimeType: 'image/png',
          data: Buffer.from('first'),
          filename: 'first.png',
        },
        {
          mimeType: 'image/jpeg',
          data: Buffer.from('second'),
          filename: 'second.jpg',
        },
      ],
    });

    const listed = await store.listRunInputImages(created.run.runId);
    expect(listed.map((image) => image.position)).toEqual([0, 1]);
    expect(listed.map((image) => image.filename)).toEqual(['first.png', 'second.jpg']);
    expect(listed.map((image) => image.imageBytes.toString('utf8'))).toEqual(['first', 'second']);

    const deletedCount = await store.deleteRunInputImages(created.run.runId);
    expect(deletedCount).toBe(2);
    await expect(store.listRunInputImages(created.run.runId)).resolves.toEqual([]);
  });

  test('idempotency dedupe with same payload does not duplicate image rows', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    const message = {
      source: 'cli',
      threadKey: 'cli:default',
      text: 'same',
      deliveryMode: 'followUp' as const,
      idempotencyKey: 'same-key',
      images: [
        {
          mimeType: 'image/png',
          data: Buffer.from('payload-a'),
          filename: 'a.png',
        },
      ],
    };

    const first = await store.createRun(message);
    const second = await store.createRun(message);

    expect(second.deduplicated).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);

    const imageCount = testDb.database
      .prepare<unknown[], { image_count: number }>('SELECT COUNT(*) AS image_count FROM input_images WHERE run_id = ?')
      .get(first.run.runId);

    expect(imageCount?.image_count).toBe(1);
  });

  test('idempotency key mismatch returns conflict error when payload differs', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'first payload',
      deliveryMode: 'followUp',
      idempotencyKey: 'idem-key',
      images: [
        {
          mimeType: 'image/png',
          data: Buffer.from('alpha'),
          filename: 'a.png',
        },
      ],
    });

    await expect(
      store.createRun({
        source: 'cli',
        threadKey: 'cli:default',
        text: 'first payload',
        deliveryMode: 'followUp',
        idempotencyKey: 'idem-key',
        images: [
          {
            mimeType: 'image/png',
            data: Buffer.from('beta'),
            filename: 'a.png',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
  });

  test('purges expired pending and run-bound image rows', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    const created = await store.createRun({
      source: 'cli',
      threadKey: 'cli:default',
      text: 'with image',
      deliveryMode: 'followUp',
      images: [
        {
          mimeType: 'image/png',
          data: Buffer.from('bound'),
          filename: 'bound.png',
        },
      ],
    });

    const now = '2026-02-17T00:00:00.000Z';
    const expired = '2026-02-01T00:00:00.000Z';

    testDb.database.prepare('UPDATE input_images SET expires_at = ? WHERE run_id = ?').run(expired, created.run.runId);
    testDb.database
      .prepare(
        `
          INSERT INTO input_images (
            input_image_id,
            source,
            thread_key,
            user_key,
            run_id,
            telegram_media_group_id,
            mime_type,
            filename,
            byte_size,
            image_bytes,
            position,
            created_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        'pending-image-1',
        'telegram',
        'telegram:chat:1',
        'telegram:user:1',
        'image/png',
        'pending.png',
        7,
        Buffer.from('pending'),
        0,
        now,
        expired,
      );

    const purge = await store.purgeExpiredInputImages({
      source: 'cli',
      threadKey: 'cli:default',
    });

    expect(purge).toEqual({
      deletedCount: 2,
      deletedBoundCount: 1,
    });

    const remaining = testDb.database
      .prepare<unknown[], { image_count: number }>('SELECT COUNT(*) AS image_count FROM input_images')
      .get();
    expect(remaining?.image_count).toBe(0);
  });
});
