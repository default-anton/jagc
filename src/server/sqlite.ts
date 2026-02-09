import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export function openSqliteDatabase(databasePath: string): SqliteDatabase {
  mkdirSync(dirname(databasePath), {
    recursive: true,
    mode: 0o700,
  });

  const database = new BetterSqlite3(databasePath);
  configureSqliteDatabase(database);

  return database;
}

export function configureSqliteDatabase(database: SqliteDatabase): void {
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
}
