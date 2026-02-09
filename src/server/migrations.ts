import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SqliteDatabase } from './sqlite.js';

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const defaultMigrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

interface MigrationFile {
  name: string;
  path: string;
}

interface LoadedMigration {
  name: string;
  sql: string;
}

export async function runMigrations(
  database: SqliteDatabase,
  migrationsDir: string = defaultMigrationsDir,
): Promise<void> {
  database.exec(migrationTableSql);

  const migrationFiles = await loadMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    throw new Error(`no migration files found in ${migrationsDir}`);
  }

  const migrations = await loadMigrationSources(migrationFiles);
  applyPendingMigrations(database, migrations);
}

async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      name: entry.name,
      path: join(migrationsDir, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadMigrationSources(files: MigrationFile[]): Promise<LoadedMigration[]> {
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      sql: await readFile(file.path, 'utf8'),
    })),
  );
}

function applyPendingMigrations(database: SqliteDatabase, migrations: LoadedMigration[]): void {
  let currentMigrationName: string | undefined;

  const apply = database.transaction((pendingMigrations: LoadedMigration[]) => {
    const applied = getAppliedMigrations(database);

    for (const migration of pendingMigrations) {
      if (applied.has(migration.name)) {
        continue;
      }

      currentMigrationName = migration.name;
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name);
      applied.add(migration.name);
    }
  });

  try {
    apply.immediate(migrations);
  } catch (error) {
    if (currentMigrationName) {
      throw new Error(
        `failed to apply migration ${currentMigrationName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    throw new Error(`failed to run migrations: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getAppliedMigrations(database: SqliteDatabase): Set<string> {
  const rows = database.prepare<unknown[], { name: string }>('SELECT name FROM schema_migrations').all();
  return new Set(rows.map((row) => row.name));
}
