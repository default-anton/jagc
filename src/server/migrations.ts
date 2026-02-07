import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const defaultMigrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

interface MigrationFile {
  name: string;
  path: string;
}

export async function runMigrations(pool: Pool, migrationsDir: string = defaultMigrationsDir): Promise<void> {
  await pool.query(migrationTableSql);

  const migrationFiles = await loadMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    throw new Error(`no migration files found in ${migrationsDir}`);
  }

  const applied = await getAppliedMigrations(pool);

  for (const migration of migrationFiles) {
    if (applied.has(migration.name)) {
      continue;
    }

    const sql = await readFile(migration.path, 'utf8');
    await applyMigration(pool, migration.name, sql);
  }
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

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(pool: Pool, name: string, sql: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`failed to apply migration ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.release();
  }
}
