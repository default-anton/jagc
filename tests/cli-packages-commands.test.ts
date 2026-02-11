import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  registerPackagesCommands,
  resolveBundledPiCliPath,
  runBundledPiPackageCommand,
} from '../src/cli/packages-commands.js';

describe('registerPackagesCommands', () => {
  test('install bootstraps workspace and forwards local install command', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const runBundledPiPackageCommandImpl = vi.fn().mockResolvedValue(undefined);

    const program = new Command();
    registerPackagesCommands(program, {
      bootstrapAgentDirImpl,
      runBundledPiPackageCommandImpl,
    });

    await program.parseAsync(
      [
        'node',
        'jagc',
        'packages',
        'install',
        'git:github.com/default-anton/pi-librarian',
        '--local',
        '--workspace-dir',
        '/tmp/jagc-workspace',
      ],
      {
        from: 'node',
      },
    );

    expect(bootstrapAgentDirImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', {
      overwriteBundledFiles: false,
      overwriteWorkspaceFiles: false,
    });
    expect(runBundledPiPackageCommandImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', [
      'install',
      'git:github.com/default-anton/pi-librarian',
      '--local',
    ]);
  });

  test('update without source forwards plain update command', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const runBundledPiPackageCommandImpl = vi.fn().mockResolvedValue(undefined);

    const program = new Command();
    registerPackagesCommands(program, {
      bootstrapAgentDirImpl,
      runBundledPiPackageCommandImpl,
    });

    await program.parseAsync(['node', 'jagc', 'packages', 'update', '--workspace-dir', '/tmp/jagc-workspace'], {
      from: 'node',
    });

    expect(runBundledPiPackageCommandImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', ['update']);
  });

  test('remove forwards local remove command', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const runBundledPiPackageCommandImpl = vi.fn().mockResolvedValue(undefined);

    const program = new Command();
    registerPackagesCommands(program, {
      bootstrapAgentDirImpl,
      runBundledPiPackageCommandImpl,
    });

    await program.parseAsync(
      [
        'node',
        'jagc',
        'packages',
        'remove',
        'git:github.com/default-anton/pi-librarian',
        '--local',
        '--workspace-dir',
        '/tmp/jagc-workspace',
      ],
      {
        from: 'node',
      },
    );

    expect(runBundledPiPackageCommandImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', [
      'remove',
      'git:github.com/default-anton/pi-librarian',
      '--local',
    ]);
  });

  test('config forwards interactive config command', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const runBundledPiPackageCommandImpl = vi.fn().mockResolvedValue(undefined);

    const program = new Command();
    registerPackagesCommands(program, {
      bootstrapAgentDirImpl,
      runBundledPiPackageCommandImpl,
    });

    await program.parseAsync(['node', 'jagc', 'packages', 'config', '--workspace-dir', '/tmp/jagc-workspace'], {
      from: 'node',
    });

    expect(runBundledPiPackageCommandImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', ['config']);
  });

  test('package alias forwards to packages command tree', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const runBundledPiPackageCommandImpl = vi.fn().mockResolvedValue(undefined);

    const program = new Command();
    registerPackagesCommands(program, {
      bootstrapAgentDirImpl,
      runBundledPiPackageCommandImpl,
    });

    await program.parseAsync(['node', 'jagc', 'package', 'list', '--workspace-dir', '/tmp/jagc-workspace'], {
      from: 'node',
    });

    expect(bootstrapAgentDirImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', {
      overwriteBundledFiles: false,
      overwriteWorkspaceFiles: false,
    });
    expect(runBundledPiPackageCommandImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', ['list']);
  });
});

describe('runBundledPiPackageCommand', () => {
  afterEach(() => {
    delete process.env.JAGC_TEST_OUTPUT_FILE;
  });

  test('runs bundled pi command in workspace with PI_CODING_AGENT_DIR', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-packages-workspace-'));
    const fixtureDir = await mkdtemp(join(tmpdir(), 'jagc-packages-fixture-'));

    try {
      const outputPath = join(fixtureDir, 'command.json');
      const cliScriptPath = join(fixtureDir, 'fake-pi-cli.mjs');

      await writeFile(
        cliScriptPath,
        [
          "import { writeFileSync } from 'node:fs';",
          'const outputPath = process.env.JAGC_TEST_OUTPUT_FILE;',
          "if (!outputPath) throw new Error('missing JAGC_TEST_OUTPUT_FILE');",
          'writeFileSync(outputPath, JSON.stringify({',
          '  cwd: process.cwd(),',
          '  piCodingAgentDir: process.env.PI_CODING_AGENT_DIR,',
          '  args: process.argv.slice(2),',
          '}));',
        ].join('\n'),
      );

      process.env.JAGC_TEST_OUTPUT_FILE = outputPath;

      await runBundledPiPackageCommand(workspaceDir, ['update', 'git:github.com/default-anton/pi-librarian'], {
        resolveBundledPiCliPathImpl: async () => cliScriptPath,
      });

      const result = JSON.parse(await readFile(outputPath, 'utf8')) as {
        cwd: string;
        piCodingAgentDir: string;
        args: string[];
      };

      const canonicalWorkspaceDir = await realpath(workspaceDir);
      const canonicalObservedCwd = await realpath(result.cwd);
      const canonicalObservedPiDir = await realpath(result.piCodingAgentDir);

      expect(canonicalObservedCwd).toBe(canonicalWorkspaceDir);
      expect(canonicalObservedPiDir).toBe(canonicalWorkspaceDir);
      expect(result.args).toEqual(['update', 'git:github.com/default-anton/pi-librarian']);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test('throws actionable error when bundled command exits non-zero', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-packages-workspace-'));
    const fixtureDir = await mkdtemp(join(tmpdir(), 'jagc-packages-fixture-'));

    try {
      const cliScriptPath = join(fixtureDir, 'fake-pi-cli-fail.mjs');
      await writeFile(cliScriptPath, 'process.exit(7);\n');

      await expect(
        runBundledPiPackageCommand(workspaceDir, ['list'], {
          resolveBundledPiCliPathImpl: async () => cliScriptPath,
        }),
      ).rejects.toThrow('bundled pi command failed (exit 7): pi list');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe('resolveBundledPiCliPath', () => {
  test('resolves bundled pi CLI from installed jagc dependency', async () => {
    const path = await resolveBundledPiCliPath();

    await expect(access(path)).resolves.toBeUndefined();
    expect(path.endsWith(`${sep}dist${sep}cli.js`)).toBe(true);
  });
});
