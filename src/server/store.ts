import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { DeliveryMode, MessageIngest, RunOutput, RunRecord } from '../shared/run-types.js';

interface RunRow {
  run_id: string;
  source: string;
  thread_key: string;
  user_key: string | null;
  delivery_mode: DeliveryMode;
  status: 'running' | 'succeeded' | 'failed';
  input_text: string;
  output: RunOutput | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ThreadSessionRow {
  thread_key: string;
  session_id: string;
  session_file: string;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadSessionRecord {
  threadKey: string;
  sessionId: string;
  sessionFile: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunResult {
  run: RunRecord;
  deduplicated: boolean;
}

export interface RunStore {
  init(): Promise<void>;
  createRun(message: MessageIngest): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRunningRuns(limit?: number): Promise<RunRecord[]>;
  markSucceeded(runId: string, output: RunOutput): Promise<void>;
  markFailed(runId: string, errorMessage: string): Promise<void>;
  getThreadSession(threadKey: string): Promise<ThreadSessionRecord | null>;
  upsertThreadSession(threadKey: string, sessionId: string, sessionFile: string): Promise<ThreadSessionRecord>;
  deleteThreadSession(threadKey: string): Promise<void>;
}

export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {}

  async createRun(message: MessageIngest): Promise<CreateRunResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      if (message.idempotencyKey) {
        const existingRun = await this.getRunByIdempotency(client, message.source, message.idempotencyKey);

        if (existingRun) {
          await client.query('COMMIT');
          return { run: existingRun, deduplicated: true };
        }
      }

      const runId = randomUUID();
      await client.query(
        `
          INSERT INTO runs (run_id, source, thread_key, user_key, delivery_mode, status, input_text)
          VALUES ($1, $2, $3, $4, $5, 'running', $6)
        `,
        [runId, message.source, message.threadKey, message.userKey ?? null, message.deliveryMode, message.text],
      );

      if (message.idempotencyKey) {
        await client.query(
          `
            INSERT INTO message_ingest (source, idempotency_key, run_id)
            VALUES ($1, $2, $3)
          `,
          [message.source, message.idempotencyKey, runId],
        );
      }

      const run = await this.getRunById(client, runId);
      if (!run) {
        throw new Error(`run ${runId} was inserted but could not be loaded`);
      }

      await client.query('COMMIT');
      return { run, deduplicated: false };
    } catch (error) {
      await client.query('ROLLBACK');

      if (message.idempotencyKey && isUniqueViolation(error)) {
        const existingRun = await this.getRunByIdempotency(client, message.source, message.idempotencyKey);

        if (existingRun) {
          return { run: existingRun, deduplicated: true };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>('SELECT * FROM runs WHERE run_id = $1', [runId]);

    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async listRunningRuns(limit: number = 1000): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `
        SELECT *
        FROM runs
        WHERE status = 'running'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit],
    );

    return result.rows.map(mapRunRow);
  }

  async markSucceeded(runId: string, output: RunOutput): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE runs
        SET status = 'succeeded',
            output = $2::jsonb,
            error_message = NULL,
            updated_at = NOW()
        WHERE run_id = $1 AND status = 'running'
      `,
      [runId, JSON.stringify(output)],
    );

    if (result.rowCount !== 1) {
      throw await statusTransitionError(this.pool, runId, 'succeeded');
    }
  }

  async markFailed(runId: string, errorMessage: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE runs
        SET status = 'failed',
            error_message = $2,
            updated_at = NOW()
        WHERE run_id = $1 AND status = 'running'
      `,
      [runId, errorMessage],
    );

    if (result.rowCount !== 1) {
      throw await statusTransitionError(this.pool, runId, 'failed');
    }
  }

  async getThreadSession(threadKey: string): Promise<ThreadSessionRecord | null> {
    const result = await this.pool.query<ThreadSessionRow>('SELECT * FROM thread_sessions WHERE thread_key = $1', [
      threadKey,
    ]);
    const row = result.rows[0];

    return row ? mapThreadSessionRow(row) : null;
  }

  async upsertThreadSession(threadKey: string, sessionId: string, sessionFile: string): Promise<ThreadSessionRecord> {
    const result = await this.pool.query<ThreadSessionRow>(
      `
        INSERT INTO thread_sessions (thread_key, session_id, session_file)
        VALUES ($1, $2, $3)
        ON CONFLICT (thread_key)
        DO UPDATE SET
          session_id = EXCLUDED.session_id,
          session_file = EXCLUDED.session_file,
          updated_at = NOW()
        RETURNING *
      `,
      [threadKey, sessionId, sessionFile],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`failed to upsert thread session for ${threadKey}`);
    }

    return mapThreadSessionRow(row);
  }

  async deleteThreadSession(threadKey: string): Promise<void> {
    await this.pool.query('DELETE FROM thread_sessions WHERE thread_key = $1', [threadKey]);
  }

  private async getRunById(client: PoolClient, runId: string): Promise<RunRecord | null> {
    const result = await client.query<RunRow>('SELECT * FROM runs WHERE run_id = $1', [runId]);
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  private async getRunByIdempotency(
    client: PoolClient,
    source: string,
    idempotencyKey: string,
  ): Promise<RunRecord | null> {
    const runResult = await client.query<RunRow>(
      `
        SELECT r.*
        FROM message_ingest mi
        INNER JOIN runs r ON r.run_id = mi.run_id
        WHERE mi.source = $1 AND mi.idempotency_key = $2
      `,
      [source, idempotencyKey],
    );

    const row = runResult.rows[0];
    return row ? mapRunRow(row) : null;
  }
}

async function statusTransitionError(pool: Pool, runId: string, targetStatus: 'succeeded' | 'failed'): Promise<Error> {
  const existing = await pool.query<Pick<RunRow, 'status'>>('SELECT status FROM runs WHERE run_id = $1', [runId]);

  const row = existing.rows[0];
  if (!row) {
    return new Error(`cannot mark run ${runId} as ${targetStatus}: run not found`);
  }

  return new Error(`cannot mark run ${runId} as ${targetStatus}: run is already ${row.status}`);
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    source: row.source,
    threadKey: row.thread_key,
    userKey: row.user_key,
    deliveryMode: row.delivery_mode,
    status: row.status,
    inputText: row.input_text,
    output: row.output,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapThreadSessionRow(row: ThreadSessionRow): ThreadSessionRecord {
  return {
    threadKey: row.thread_key,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return 'code' in error && (error as { code?: string }).code === '23505';
}
