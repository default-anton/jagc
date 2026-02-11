import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { applyNodeEnvFileOverrides, parseNodeEnvFileArgs } from '../src/server/env-file-overrides.js';

describe('parseNodeEnvFileArgs', () => {
  test('parses --env-file and --env-file-if-exists in order', () => {
    const parsed = parseNodeEnvFileArgs([
      '--trace-warnings',
      '--env-file-if-exists=/tmp/snapshot.env',
      '--env-file-if-exists',
      '/tmp/user.env',
      '--env-file=/tmp/required.env',
      '--env-file',
      '/tmp/required-2.env',
    ]);

    expect(parsed).toEqual([
      { path: '/tmp/snapshot.env', optional: true },
      { path: '/tmp/user.env', optional: true },
      { path: '/tmp/required.env', optional: false },
      { path: '/tmp/required-2.env', optional: false },
    ]);
  });
});

describe('applyNodeEnvFileOverrides', () => {
  test('overrides existing process env values using env-file order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-env-override-'));
    const snapshotPath = join(root, 'service.env.snapshot');
    const userPath = join(root, 'service.env');

    await writeFile(snapshotPath, 'PATH=/snapshot/bin\nSHARED=from_snapshot\nSNAPSHOT_ONLY=1\n', 'utf8');
    await writeFile(userPath, 'PATH=/user/bin\nSHARED=from_user\nUSER_ONLY=1\n', 'utf8');

    const previousPath = process.env.PATH;
    const previousShared = process.env.SHARED;
    const previousSnapshotOnly = process.env.SNAPSHOT_ONLY;
    const previousUserOnly = process.env.USER_ONLY;

    process.env.PATH = '/usr/bin:/bin';
    process.env.SHARED = 'from_parent';
    delete process.env.SNAPSHOT_ONLY;
    delete process.env.USER_ONLY;

    try {
      const applied = applyNodeEnvFileOverrides([
        `--env-file-if-exists=${snapshotPath}`,
        `--env-file-if-exists=${userPath}`,
      ]);

      expect(applied).toEqual([snapshotPath, userPath]);
      expect(process.env.PATH).toBe('/user/bin');
      expect(process.env.SHARED).toBe('from_user');
      expect(process.env.SNAPSHOT_ONLY).toBe('1');
      expect(process.env.USER_ONLY).toBe('1');
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }

      if (previousShared === undefined) {
        delete process.env.SHARED;
      } else {
        process.env.SHARED = previousShared;
      }

      if (previousSnapshotOnly === undefined) {
        delete process.env.SNAPSHOT_ONLY;
      } else {
        process.env.SNAPSHOT_ONLY = previousSnapshotOnly;
      }

      if (previousUserOnly === undefined) {
        delete process.env.USER_ONLY;
      } else {
        process.env.USER_ONLY = previousUserOnly;
      }

      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips missing --env-file-if-exists entries', () => {
    const previous = process.env.JAGC_TEST_MISSING_OPTIONAL;
    delete process.env.JAGC_TEST_MISSING_OPTIONAL;

    try {
      const applied = applyNodeEnvFileOverrides(['--env-file-if-exists=/tmp/jagc-missing-optional.env']);
      expect(applied).toEqual([]);
      expect(process.env.JAGC_TEST_MISSING_OPTIONAL).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.JAGC_TEST_MISSING_OPTIONAL;
      } else {
        process.env.JAGC_TEST_MISSING_OPTIONAL = previous;
      }
    }
  });
});
