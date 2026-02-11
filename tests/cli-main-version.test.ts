import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('cli version flag', () => {
  test('prints package version with --version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test('prints package version with -v', () => {
    const result = runCli(['-v']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });
});
