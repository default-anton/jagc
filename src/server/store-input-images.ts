import { randomUUID } from 'node:crypto';
import {
  computeInputImagesTotalBytes,
  expiresAtFromIsoTimestamp,
  InputImageValidationError,
  maxInputImageCount,
  maxInputImageTotalBytes,
  validateDecodedInputImages,
} from '../shared/input-images.js';
import type { Logger } from '../shared/logger.js';
import { noopLogger } from '../shared/logger.js';
import type { MessageIngest } from '../shared/run-types.js';
import type { SqliteDatabase } from './sqlite.js';
import type {
  PendingTelegramImageIngest,
  PendingTelegramImageIngestResult,
  PendingTelegramImageScope,
} from './store-input-images-telegram.js';
import { isTelegramUpdateDedupConstraint } from './store-input-images-telegram.js';

export type {
  PendingTelegramImageIngest,
  PendingTelegramImageIngestResult,
  PendingTelegramImageScope,
} from './store-input-images-telegram.js';

interface InputImageRow {
  input_image_id: string;
  mime_type: string;
  filename: string | null;
  byte_size: number;
  image_bytes: Buffer;
  position: number;
}

interface DeleteRunImagesStatsRow {
  image_count: number;
  total_bytes: number;
  source: string | null;
  thread_key: string | null;
}

interface PurgeExpiredStatsRow {
  image_count: number;
  bound_count: number;
}

interface PendingScopeStatsRow {
  image_count: number;
  total_bytes: number;
  max_position: number | null;
}

interface PendingInsertTxResult {
  insertedCount: number;
  insertedBytes: number;
  bufferedCount: number;
  bufferedBytes: number;
}

const emptyDeleteStats: DeleteRunImagesStatsRow = {
  image_count: 0,
  total_bytes: 0,
  source: null,
  thread_key: null,
};

const emptyPurgeStats: PurgeExpiredStatsRow = { image_count: 0, bound_count: 0 };

const emptyPendingScopeStats: PendingScopeStatsRow = {
  image_count: 0,
  total_bytes: 0,
  max_position: null,
};

export interface ImageLogContext {
  source?: string;
  threadKey?: string;
  runId?: string;
}

export interface RunInputImageRecord {
  inputImageId: string;
  mimeType: string;
  filename: string | null;
  byteSize: number;
  imageBytes: Buffer;
  position: number;
}

export interface PurgeExpiredInputImagesResult {
  deletedCount: number;
  deletedBoundCount: number;
}

export class RunInputImageStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly logger: Logger = noopLogger,
  ) {}

  listRunInputImages(runId: string): RunInputImageRecord[] {
    const rows = this.database
      .prepare<unknown[], InputImageRow>(
        `
          SELECT input_image_id, mime_type, filename, byte_size, image_bytes, position
          FROM input_images
          WHERE run_id = ?
          ORDER BY position ASC, input_image_id ASC
        `,
      )
      .all(runId);

    return rows.map(mapInputImageRow);
  }

  deleteRunInputImages(runId: string): number {
    const remove = this.database.transaction((targetRunId: string): DeleteRunImagesStatsRow => {
      const stats =
        this.database
          .prepare<unknown[], DeleteRunImagesStatsRow>(
            `
              SELECT
                COUNT(*) AS image_count,
                COALESCE(SUM(byte_size), 0) AS total_bytes,
                MIN(source) AS source,
                MIN(thread_key) AS thread_key
              FROM input_images
              WHERE run_id = ?
            `,
          )
          .get(targetRunId) ?? emptyDeleteStats;

      if (stats.image_count > 0) {
        this.database.prepare('DELETE FROM input_images WHERE run_id = ?').run(targetRunId);
      }

      return stats;
    });

    const deleted = remove(runId);
    if (deleted.image_count > 0) {
      this.logger.info({
        event: 'images_deleted_after_delivery_count',
        images_deleted_after_delivery_count: deleted.image_count,
        images_deleted_after_delivery_bytes: deleted.total_bytes,
        source: deleted.source,
        thread_key: deleted.thread_key,
        run_id: runId,
      });
    }

    return deleted.image_count;
  }

  purgeExpiredInputImages(context?: ImageLogContext): PurgeExpiredInputImagesResult {
    const nowIso = nowIsoTimestamp();
    const purge = this.database.transaction((logContext: ImageLogContext | undefined) =>
      this.purgeExpiredInputImagesTx(nowIso, logContext),
    );

    return purge(context);
  }

  purgeExpiredInputImagesTx(nowIso: string, context?: ImageLogContext): PurgeExpiredInputImagesResult {
    const stats =
      this.database
        .prepare<unknown[], PurgeExpiredStatsRow>(
          `
            SELECT
              COUNT(*) AS image_count,
              COALESCE(SUM(CASE WHEN run_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS bound_count
            FROM input_images
            WHERE expires_at <= ?
          `,
        )
        .get(nowIso) ?? emptyPurgeStats;

    if (stats.image_count > 0) {
      this.database.prepare('DELETE FROM input_images WHERE expires_at <= ?').run(nowIso);
      this.logger.info({
        event: 'images_purged_expired_count',
        images_purged_expired_count: stats.image_count,
        source: context?.source ?? null,
        thread_key: context?.threadKey ?? null,
        run_id: context?.runId ?? null,
      });
    }

    if (stats.bound_count > 0) {
      this.logger.warn({
        event: 'images_purged_expired_bound_count',
        images_purged_expired_bound_count: stats.bound_count,
        source: context?.source ?? null,
        thread_key: context?.threadKey ?? null,
        run_id: context?.runId ?? null,
      });
    }

    return {
      deletedCount: stats.image_count,
      deletedBoundCount: stats.bound_count,
    };
  }

  insertPendingTelegramImages(input: PendingTelegramImageIngest): PendingTelegramImageIngestResult {
    validateDecodedInputImages(input.images);

    if (input.images.length === 0) {
      return {
        insertedCount: 0,
        bufferedCount: 0,
        bufferedBytes: 0,
      };
    }

    const nowIso = nowIsoTimestamp();
    const insert = this.database.transaction((payload: PendingTelegramImageIngest): PendingInsertTxResult => {
      this.purgeExpiredInputImagesTx(nowIso, {
        source: payload.source,
        threadKey: payload.threadKey,
      });

      const existing = this.loadPendingScopeStatsTx(payload.source, payload.threadKey, payload.userKey);
      if (
        this.hasTelegramUpdateBeenBufferedTx(
          payload.source,
          payload.threadKey,
          payload.userKey,
          payload.telegramUpdateId,
        )
      ) {
        return {
          insertedCount: 0,
          insertedBytes: 0,
          bufferedCount: existing.image_count,
          bufferedBytes: existing.total_bytes,
        };
      }

      const insertedBytes = computeInputImagesTotalBytes(payload.images);
      const bufferedCount = existing.image_count + payload.images.length;
      const bufferedBytes = existing.total_bytes + insertedBytes;

      this.assertPendingBufferWithinLimits(bufferedCount, bufferedBytes);

      const insertStatement = this.database.prepare(
        `
          INSERT INTO input_images (
            input_image_id,
            source,
            thread_key,
            user_key,
            telegram_update_id,
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
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      const expiresAt = expiresAtFromIsoTimestamp(nowIso);
      let position = (existing.max_position ?? -1) + 1;
      for (const image of payload.images) {
        insertStatement.run(
          randomUUID(),
          payload.source,
          payload.threadKey,
          payload.userKey,
          payload.telegramUpdateId,
          payload.telegramMediaGroupId ?? null,
          image.mimeType,
          image.filename ?? null,
          image.data.byteLength,
          image.data,
          position,
          nowIso,
          expiresAt,
        );
        position += 1;
      }

      return {
        insertedCount: payload.images.length,
        insertedBytes,
        bufferedCount,
        bufferedBytes,
      };
    });

    let inserted: PendingInsertTxResult;
    try {
      inserted = insert(input);
    } catch (error) {
      if (isTelegramUpdateDedupConstraint(error)) {
        const pending = this.loadPendingScopeStatsTx(input.source, input.threadKey, input.userKey);
        inserted = {
          insertedCount: 0,
          insertedBytes: 0,
          bufferedCount: pending.image_count,
          bufferedBytes: pending.total_bytes,
        };
      } else {
        throw error;
      }
    }
    if (inserted.insertedCount > 0) {
      this.logger.info({
        event: 'images_ingested_count',
        images_ingested_count: inserted.insertedCount,
        images_ingested_bytes: inserted.insertedBytes,
        source: input.source,
        thread_key: input.threadKey,
        run_id: null,
      });
    } else {
      this.logger.info({
        event: 'telegram_image_ingest_deduplicated',
        source: input.source,
        thread_key: input.threadKey,
        run_id: null,
        telegram_update_id: input.telegramUpdateId,
      });
    }

    return {
      insertedCount: inserted.insertedCount,
      bufferedCount: inserted.bufferedCount,
      bufferedBytes: inserted.bufferedBytes,
    };
  }

  claimPendingTelegramImagesToRunTx(scope: PendingTelegramImageScope, runId: string, claimedAtIso: string): number {
    const pending = this.loadPendingScopeStatsTx(scope.source, scope.threadKey, scope.userKey);
    if (pending.image_count === 0) {
      return 0;
    }

    const expiresAt = expiresAtFromIsoTimestamp(claimedAtIso);
    const claimed = this.database
      .prepare(
        `
          UPDATE input_images
          SET run_id = ?,
              expires_at = ?
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND run_id IS NULL
        `,
      )
      .run(runId, expiresAt, scope.source, scope.threadKey, scope.userKey).changes;

    if (claimed > 0) {
      this.logger.info({
        event: 'images_claimed_count',
        images_claimed_count: claimed,
        images_claimed_bytes: pending.total_bytes,
        source: scope.source,
        thread_key: scope.threadKey,
        run_id: runId,
      });
    }

    return claimed;
  }

  insertRunInputImages(runId: string, input: MessageIngest, createdAtIso: string): void {
    const images = input.images ?? [];
    if (images.length === 0) {
      return;
    }

    const expiresAt = expiresAtFromIsoTimestamp(createdAtIso);
    const insert = this.database.prepare(
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
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    let totalBytes = 0;
    for (const [position, image] of images.entries()) {
      const byteSize = image.data.byteLength;
      totalBytes += byteSize;

      insert.run(
        randomUUID(),
        input.source,
        input.threadKey,
        input.userKey ?? null,
        runId,
        image.mimeType,
        image.filename ?? null,
        byteSize,
        image.data,
        position,
        createdAtIso,
        expiresAt,
      );
    }

    this.logger.info({
      event: 'images_ingested_count',
      images_ingested_count: images.length,
      images_ingested_bytes: totalBytes,
      source: input.source,
      thread_key: input.threadKey,
      run_id: runId,
    });
  }

  private loadPendingScopeStatsTx(source: string, threadKey: string, userKey: string): PendingScopeStatsRow {
    return (
      this.database
        .prepare<unknown[], PendingScopeStatsRow>(
          `
            SELECT
              COUNT(*) AS image_count,
              COALESCE(SUM(byte_size), 0) AS total_bytes,
              MAX(position) AS max_position
            FROM input_images
            WHERE source = ?
              AND thread_key = ?
              AND user_key = ?
              AND run_id IS NULL
          `,
        )
        .get(source, threadKey, userKey) ?? emptyPendingScopeStats
    );
  }

  private hasTelegramUpdateBeenBufferedTx(
    source: string,
    threadKey: string,
    userKey: string,
    telegramUpdateId: number,
  ): boolean {
    const existing = this.database
      .prepare<unknown[], { input_image_id: string }>(
        `
          SELECT input_image_id
          FROM input_images
          WHERE source = ?
            AND thread_key = ?
            AND user_key = ?
            AND telegram_update_id = ?
          LIMIT 1
        `,
      )
      .get(source, threadKey, userKey, telegramUpdateId);

    return existing !== undefined;
  }

  private assertPendingBufferWithinLimits(bufferedCount: number, bufferedBytes: number): void {
    if (bufferedCount > maxInputImageCount || bufferedBytes > maxInputImageTotalBytes) {
      throw new InputImageValidationError(
        'image_buffer_limit_exceeded',
        `pending image buffer exceeds limit (${maxInputImageCount} images, ${maxInputImageTotalBytes} bytes max)`,
      );
    }
  }
}

function mapInputImageRow(row: InputImageRow): RunInputImageRecord {
  return {
    inputImageId: row.input_image_id,
    mimeType: row.mime_type,
    filename: row.filename,
    byteSize: row.byte_size,
    imageBytes: row.image_bytes,
    position: row.position,
  };
}

function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
