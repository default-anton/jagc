import { Pool } from 'pg';
import { testTransaction } from 'pg-transactional-tests';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { runMigrations } from '../../src/server/migrations.js';

interface PostgresTestDb {
  pool: Pool;
  connectionString: string;
  databaseName: string;
}

export function usePostgresTestDb(): PostgresTestDb {
  const connectionString = resolveWorkerConnectionString();
  const databaseName = databaseNameFromUrl(new URL(connectionString));
  const pool = new Pool({
    connectionString,
    max: 1,
  });

  beforeAll(async () => {
    await ensureDatabaseExists(connectionString, databaseName);

    const migrationPool = new Pool({
      connectionString,
      max: 1,
    });

    try {
      await runMigrations(migrationPool);
    } finally {
      await migrationPool.end();
    }
  });

  beforeAll(testTransaction.start);
  beforeEach(testTransaction.start);
  afterEach(testTransaction.rollback);

  afterAll(async () => {
    await testTransaction.close();
    await pool.end();
  });

  return {
    pool,
    connectionString,
    databaseName,
  };
}

function resolveWorkerConnectionString(): string {
  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1';
  const baseUrl = resolveBaseUrl();
  const baseDatabaseName = databaseNameFromUrl(baseUrl);

  baseUrl.pathname = `/${baseDatabaseName}_${workerId}`;
  return baseUrl.toString();
}

function resolveBaseUrl(): URL {
  const raw =
    process.env.JAGC_TEST_DATABASE_URL ??
    deriveTestUrlFromAppDatabaseUrl() ??
    'postgres://postgres@127.0.0.1:5432/jagc_test';

  return new URL(raw);
}

function deriveTestUrlFromAppDatabaseUrl(): string | null {
  const appDatabaseUrl = process.env.JAGC_DATABASE_URL;
  if (!appDatabaseUrl) {
    return null;
  }

  const url = new URL(appDatabaseUrl);
  const databaseName = databaseNameFromUrl(url);
  url.pathname = `/${databaseName}_test`;

  return url.toString();
}

function databaseNameFromUrl(url: URL): string {
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) {
    throw new Error(`database name is missing in ${url.toString()}`);
  }

  return databaseName;
}

async function ensureDatabaseExists(connectionString: string, databaseName: string): Promise<void> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = `/${process.env.JAGC_TEST_ADMIN_DATABASE ?? 'postgres'}`;

  const adminPool = new Pool({
    connectionString: adminUrl.toString(),
    max: 1,
  });

  try {
    const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (result.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } catch (error) {
    if (!isDuplicateDatabaseError(error)) {
      throw error;
    }
  } finally {
    await adminPool.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isDuplicateDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return 'code' in error && (error as { code?: string }).code === '42P04';
}
