import { describe, expect, test } from 'vitest';

import { IdempotencyPayloadMismatchError, SqliteRunStore } from '../src/server/store.js';
import { InputImageValidationError } from '../src/shared/input-images.js';
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

  test('persists pending Telegram images with deterministic positions', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 1_001,
      telegramMediaGroupId: 'group-1',
      images: [
        {
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          filename: null,
        },
      ],
    });

    await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 1_002,
      telegramMediaGroupId: 'group-1',
      images: [
        {
          mimeType: 'image/png',
          data: Buffer.from('second'),
          filename: 'second.png',
        },
      ],
    });

    const rows = testDb.database
      .prepare<
        unknown[],
        { position: number; telegram_media_group_id: string | null; mime_type: string; filename: string | null }
      >(
        `
          SELECT position, telegram_media_group_id, mime_type, filename
          FROM input_images
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
          ORDER BY position ASC, input_image_id ASC
        `,
      )
      .all('telegram', 'telegram:chat:1', 'telegram:user:1');

    expect(rows).toEqual([
      {
        position: 0,
        telegram_media_group_id: 'group-1',
        mime_type: 'image/jpeg',
        filename: null,
      },
      {
        position: 1,
        telegram_media_group_id: 'group-1',
        mime_type: 'image/png',
        filename: 'second.png',
      },
    ]);
  });

  test('deduplicates pending Telegram image ingest by update id', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    const first = await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 1_500,
      images: [
        {
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          filename: null,
        },
      ],
    });

    const second = await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 1_500,
      images: [
        {
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          filename: null,
        },
      ],
    });

    expect(first).toMatchObject({
      insertedCount: 1,
      bufferedCount: 1,
    });
    expect(second).toMatchObject({
      insertedCount: 0,
      bufferedCount: 1,
    });

    const pendingRows = testDb.database
      .prepare<unknown[], { image_count: number }>(
        `
          SELECT COUNT(*) AS image_count
          FROM input_images
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
        `,
      )
      .get('telegram', 'telegram:chat:1', 'telegram:user:1');

    expect(pendingRows?.image_count).toBe(1);
  });

  test('claims pending Telegram images to run on text ingest and refreshes expiry', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 2_001,
      images: [
        {
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          filename: null,
        },
      ],
    });

    const staleExpiry = '2099-01-01T00:00:00.000Z';
    testDb.database
      .prepare(
        `
          UPDATE input_images
          SET expires_at = ?
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
        `,
      )
      .run(staleExpiry, 'telegram', 'telegram:chat:1', 'telegram:user:1');

    const created = await store.createRun({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      text: 'describe buffered image',
      deliveryMode: 'followUp',
    });

    const runImages = await store.listRunInputImages(created.run.runId);
    expect(runImages).toHaveLength(1);
    expect(runImages[0]?.mimeType).toBe('image/jpeg');

    const pendingCount = testDb.database
      .prepare<unknown[], { image_count: number }>(
        `
          SELECT COUNT(*) AS image_count
          FROM input_images
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
        `,
      )
      .get('telegram', 'telegram:chat:1', 'telegram:user:1');
    expect(pendingCount?.image_count).toBe(0);

    const refreshedExpiry = testDb.database
      .prepare<unknown[], { expires_at: string }>('SELECT expires_at FROM input_images WHERE run_id = ? LIMIT 1')
      .get(created.run.runId);
    expect(refreshedExpiry?.expires_at).not.toBe(staleExpiry);
  });

  test('rejects pending Telegram buffer overflow with stable error code', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

    for (let index = 0; index < 10; index += 1) {
      await store.persistPendingTelegramInputImages({
        source: 'telegram',
        threadKey: 'telegram:chat:1',
        userKey: 'telegram:user:1',
        telegramUpdateId: 3_000 + index,
        images: [
          {
            mimeType: 'image/jpeg',
            data: Buffer.from([0xff, 0xd8, 0xff, index]),
            filename: null,
          },
        ],
      });
    }

    await expect(
      store.persistPendingTelegramInputImages({
        source: 'telegram',
        threadKey: 'telegram:chat:1',
        userKey: 'telegram:user:1',
        telegramUpdateId: 3_999,
        images: [
          {
            mimeType: 'image/jpeg',
            data: Buffer.from([0xff, 0xd8, 0xff, 0x10]),
            filename: null,
          },
        ],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: InputImageValidationError.name,
        code: 'image_buffer_limit_exceeded',
      }),
    );
  });

  test('pending Telegram image ingest purges expired rows first', async () => {
    const store = new SqliteRunStore(testDb.database);
    await store.init();

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
        'expired-pending-image',
        'telegram',
        'telegram:chat:1',
        'telegram:user:1',
        'image/png',
        'expired.png',
        7,
        Buffer.from('expired'),
        0,
        '2026-02-10T00:00:00.000Z',
        '2026-02-11T00:00:00.000Z',
      );

    await store.persistPendingTelegramInputImages({
      source: 'telegram',
      threadKey: 'telegram:chat:1',
      userKey: 'telegram:user:1',
      telegramUpdateId: 4_001,
      images: [
        {
          mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          filename: null,
        },
      ],
    });

    const pendingRows = testDb.database
      .prepare<unknown[], { image_count: number }>(
        `
          SELECT COUNT(*) AS image_count
          FROM input_images
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
        `,
      )
      .get('telegram', 'telegram:chat:1', 'telegram:user:1');

    expect(pendingRows?.image_count).toBe(1);
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
