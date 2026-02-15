import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { runMigrations } from '../../src/server/migrations.js';
import { configureSqliteDatabase, type SqliteDatabase } from '../../src/server/sqlite.js';

interface SqliteTestDb {
  database: SqliteDatabase;
}

export function useSqliteTestDb(): SqliteTestDb {
  const database = new BetterSqlite3(':memory:');
  configureSqliteDatabase(database);

  beforeAll(async () => {
    await runMigrations(database);
  });

  beforeEach(() => {
    resetDatabase(database);
  });

  afterAll(async () => {
    database.close();
  });

  return {
    database,
  };
}

function resetDatabase(database: SqliteDatabase): void {
  database.exec(`
    DELETE FROM message_ingest;
    DELETE FROM thread_sessions;
    DELETE FROM scheduled_task_runs;
    DELETE FROM scheduled_tasks;
    DELETE FROM runs;
  `);
}
