import { randomUUID } from 'node:crypto';
import type { DeliveryMode, MessageIngest, RunOutput, RunRecord } from '../shared/run-types.js';
import type { SqliteDatabase } from './sqlite.js';

interface RunRow {
  run_id: string;
  source: string;
  thread_key: string;
  user_key: string | null;
  delivery_mode: DeliveryMode;
  status: 'running' | 'succeeded' | 'failed';
  input_text: string;
  output: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ThreadSessionRow {
  thread_key: string;
  session_id: string;
  session_file: string;
  created_at: string;
  updated_at: string;
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

export class SqliteRunStore implements RunStore {
  constructor(private readonly database: SqliteDatabase) {}

  async init(): Promise<void> {}

  async createRun(message: MessageIngest): Promise<CreateRunResult> {
    const create = this.database.transaction((input: MessageIngest): CreateRunResult => {
      if (input.idempotencyKey) {
        const existingRun = this.getRunByIdempotency(input.source, input.idempotencyKey);
        if (existingRun) {
          return {
            run: existingRun,
            deduplicated: true,
          };
        }
      }

      const runId = randomUUID();
      const now = nowIsoTimestamp();

      this.database
        .prepare(
          `
            INSERT INTO runs (run_id, source, thread_key, user_key, delivery_mode, status, input_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
          `,
        )
        .run(runId, input.source, input.threadKey, input.userKey ?? null, input.deliveryMode, input.text, now, now);

      if (input.idempotencyKey) {
        this.database
          .prepare(
            `
              INSERT INTO message_ingest (source, idempotency_key, run_id, created_at)
              VALUES (?, ?, ?, ?)
            `,
          )
          .run(input.source, input.idempotencyKey, runId, now);
      }

      const run = this.getRunById(runId);
      if (!run) {
        throw new Error(`run ${runId} was inserted but could not be loaded`);
      }

      return {
        run,
        deduplicated: false,
      };
    });

    try {
      return create(message);
    } catch (error) {
      if (message.idempotencyKey && isSqliteConstraintViolation(error)) {
        const existingRun = this.getRunByIdempotency(message.source, message.idempotencyKey);
        if (existingRun) {
          return {
            run: existingRun,
            deduplicated: true,
          };
        }
      }

      throw error;
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.getRunById(runId);
  }

  async listRunningRuns(limit: number = 1000): Promise<RunRecord[]> {
    const rows = this.database
      .prepare<unknown[], RunRow>(
        `
          SELECT *
          FROM runs
          WHERE status = 'running'
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(limit);

    return rows.map(mapRunRow);
  }

  async markSucceeded(runId: string, output: RunOutput): Promise<void> {
    const result = this.database
      .prepare(
        `
          UPDATE runs
          SET status = 'succeeded',
              output = ?,
              error_message = NULL,
              updated_at = ?
          WHERE run_id = ? AND status = 'running'
        `,
      )
      .run(JSON.stringify(output), nowIsoTimestamp(), runId);

    if (result.changes !== 1) {
      throw statusTransitionError(this.database, runId, 'succeeded');
    }
  }

  async markFailed(runId: string, errorMessage: string): Promise<void> {
    const result = this.database
      .prepare(
        `
          UPDATE runs
          SET status = 'failed',
              error_message = ?,
              updated_at = ?
          WHERE run_id = ? AND status = 'running'
        `,
      )
      .run(errorMessage, nowIsoTimestamp(), runId);

    if (result.changes !== 1) {
      throw statusTransitionError(this.database, runId, 'failed');
    }
  }

  async getThreadSession(threadKey: string): Promise<ThreadSessionRecord | null> {
    const row = this.database
      .prepare<unknown[], ThreadSessionRow>('SELECT * FROM thread_sessions WHERE thread_key = ?')
      .get(threadKey);

    return row ? mapThreadSessionRow(row) : null;
  }

  async upsertThreadSession(threadKey: string, sessionId: string, sessionFile: string): Promise<ThreadSessionRecord> {
    this.database
      .prepare(
        `
          INSERT INTO thread_sessions (thread_key, session_id, session_file, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (thread_key)
          DO UPDATE SET
            session_id = excluded.session_id,
            session_file = excluded.session_file,
            updated_at = excluded.updated_at
        `,
      )
      .run(threadKey, sessionId, sessionFile, nowIsoTimestamp(), nowIsoTimestamp());

    const row = this.database
      .prepare<unknown[], ThreadSessionRow>('SELECT * FROM thread_sessions WHERE thread_key = ?')
      .get(threadKey);

    if (!row) {
      throw new Error(`failed to upsert thread session for ${threadKey}`);
    }

    return mapThreadSessionRow(row);
  }

  async deleteThreadSession(threadKey: string): Promise<void> {
    this.database.prepare('DELETE FROM thread_sessions WHERE thread_key = ?').run(threadKey);
  }

  private getRunById(runId: string): RunRecord | null {
    const row = this.database.prepare<unknown[], RunRow>('SELECT * FROM runs WHERE run_id = ?').get(runId);
    return row ? mapRunRow(row) : null;
  }

  private getRunByIdempotency(source: string, idempotencyKey: string): RunRecord | null {
    const row = this.database
      .prepare<unknown[], RunRow>(
        `
          SELECT r.*
          FROM message_ingest mi
          INNER JOIN runs r ON r.run_id = mi.run_id
          WHERE mi.source = ? AND mi.idempotency_key = ?
        `,
      )
      .get(source, idempotencyKey);

    return row ? mapRunRow(row) : null;
  }
}

function statusTransitionError(database: SqliteDatabase, runId: string, targetStatus: 'succeeded' | 'failed'): Error {
  const row = database
    .prepare<unknown[], Pick<RunRow, 'status'>>('SELECT status FROM runs WHERE run_id = ?')
    .get(runId);

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
    output: parseOutput(row.run_id, row.output),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThreadSessionRow(row: ThreadSessionRow): ThreadSessionRecord {
  return {
    threadKey: row.thread_key,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOutput(runId: string, serialized: string | null): RunOutput | null {
  if (serialized === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(serialized);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('run output must be a JSON object');
    }

    return parsed as RunOutput;
  } catch (error) {
    throw new Error(
      `failed to parse run ${runId} output JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isSqliteConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (!('code' in error)) {
    return false;
  }

  const code = (error as { code?: string }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
