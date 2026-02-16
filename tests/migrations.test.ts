import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../src/server/migrations.js';
import { openSqliteDatabase } from '../src/server/sqlite.js';

describe('runMigrations', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }

    tempDirs.length = 0;
  });

  test('concurrent migration runners against the same sqlite file both succeed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'jagc-migrations-'));
    tempDirs.push(tempDir);

    const databasePath = join(tempDir, 'jagc.sqlite');
    const first = openSqliteDatabase(databasePath);
    const second = openSqliteDatabase(databasePath);

    try {
      await Promise.all([runMigrations(first), runMigrations(second)]);

      const applied = first
        .prepare<unknown[], { name: string }>('SELECT name FROM schema_migrations ORDER BY name')
        .all()
        .map((row) => row.name);

      expect(applied).toEqual([
        '001_runs_and_ingest.sql',
        '002_thread_sessions.sql',
        '003_scheduled_tasks.sql',
        '004_scheduled_tasks_rrule.sql',
      ]);
    } finally {
      first.close();
      second.close();
    }
  });
});
