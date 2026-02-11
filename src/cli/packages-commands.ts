import { type ChildProcess, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { exitWithError } from './common.js';

const defaultWorkspaceDir = process.env.JAGC_WORKSPACE_DIR ?? join(homedir(), '.jagc');

type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: 'inherit';
  },
) => ChildProcess;

interface InstallRemoveCommandOptions {
  workspaceDir: string;
  local?: boolean;
}

interface UpdateCommandOptions {
  workspaceDir: string;
}

interface WorkspaceCommandOptions {
  workspaceDir: string;
}

interface PackagesCommandsDependencies {
  bootstrapAgentDirImpl?: typeof bootstrapAgentDir;
  runBundledPiPackageCommandImpl?: typeof runBundledPiPackageCommand;
}

export interface RunBundledPiPackageCommandDependencies {
  resolveBundledPiCliPathImpl?: typeof resolveBundledPiCliPath;
  spawnImpl?: SpawnCommand;
  nodePath?: string;
}

export function registerPackagesCommands(program: Command, dependencies: PackagesCommandsDependencies = {}): void {
  const bootstrapAgentDirImpl = dependencies.bootstrapAgentDirImpl ?? bootstrapAgentDir;
  const runBundledPiPackageCommandImpl = dependencies.runBundledPiPackageCommandImpl ?? runBundledPiPackageCommand;

  const packagesCommand = program
    .command('packages')
    .alias('package')
    .description('manage pi packages in the jagc workspace');

  packagesCommand
    .command('install')
    .argument('<source>', 'package source (npm:, git:, URL, or local path)')
    .option('-l, --local', 'install project-locally (.pi/settings.json)')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .action(async (source: string, options: InstallRemoveCommandOptions) => {
      try {
        await bootstrapWorkspace(bootstrapAgentDirImpl, options.workspaceDir);

        const args = ['install', source];
        if (options.local) {
          args.push('--local');
        }

        await runBundledPiPackageCommandImpl(options.workspaceDir, args);
      } catch (error) {
        exitWithError(error);
      }
    });

  packagesCommand
    .command('remove')
    .argument('<source>', 'package source to remove')
    .option('-l, --local', 'remove project-local source (.pi/settings.json)')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .action(async (source: string, options: InstallRemoveCommandOptions) => {
      try {
        await bootstrapWorkspace(bootstrapAgentDirImpl, options.workspaceDir);

        const args = ['remove', source];
        if (options.local) {
          args.push('--local');
        }

        await runBundledPiPackageCommandImpl(options.workspaceDir, args);
      } catch (error) {
        exitWithError(error);
      }
    });

  packagesCommand
    .command('update')
    .argument('[source]', 'specific package source to update')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .action(async (source: string | undefined, options: UpdateCommandOptions) => {
      try {
        await bootstrapWorkspace(bootstrapAgentDirImpl, options.workspaceDir);

        const args = source ? ['update', source] : ['update'];
        await runBundledPiPackageCommandImpl(options.workspaceDir, args);
      } catch (error) {
        exitWithError(error);
      }
    });

  packagesCommand
    .command('list')
    .description('list installed package sources from workspace/user settings')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .action(async (options: WorkspaceCommandOptions) => {
      try {
        await bootstrapWorkspace(bootstrapAgentDirImpl, options.workspaceDir);
        await runBundledPiPackageCommandImpl(options.workspaceDir, ['list']);
      } catch (error) {
        exitWithError(error);
      }
    });

  packagesCommand
    .command('config')
    .description('open interactive package resource configuration')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .action(async (options: WorkspaceCommandOptions) => {
      try {
        await bootstrapWorkspace(bootstrapAgentDirImpl, options.workspaceDir);
        await runBundledPiPackageCommandImpl(options.workspaceDir, ['config']);
      } catch (error) {
        exitWithError(error);
      }
    });
}

async function bootstrapWorkspace(
  bootstrapAgentDirImpl: typeof bootstrapAgentDir,
  workspaceDir: string,
): Promise<void> {
  await bootstrapAgentDirImpl(workspaceDir, {
    overwriteBundledFiles: false,
    overwriteWorkspaceFiles: false,
  });
}

export async function runBundledPiPackageCommand(
  workspaceDir: string,
  piArgs: string[],
  dependencies: RunBundledPiPackageCommandDependencies = {},
): Promise<void> {
  const resolveBundledPiCliPathImpl = dependencies.resolveBundledPiCliPathImpl ?? resolveBundledPiCliPath;
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const nodePath = dependencies.nodePath ?? process.execPath;

  const piCliPath = await resolveBundledPiCliPathImpl();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawnImpl(nodePath, [piCliPath, ...piArgs], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: workspaceDir,
      },
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      rejectPromise(new Error(`failed to launch bundled pi command: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`bundled pi command interrupted by signal ${signal}`));
        return;
      }

      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        rejectPromise(new Error(`bundled pi command failed (exit ${exitCode}): pi ${piArgs.join(' ')}`));
        return;
      }

      resolvePromise();
    });
  });
}

export async function resolveBundledPiCliPath(): Promise<string> {
  let packageEntryUrl: string;

  try {
    packageEntryUrl = import.meta.resolve('@mariozechner/pi-coding-agent');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to resolve bundled pi dependency (@mariozechner/pi-coding-agent): ${message}`);
  }

  const packageEntryPath = fileURLToPath(packageEntryUrl);
  const packageEntryDirectory = dirname(packageEntryPath);
  const cliPathCandidates = [
    join(packageEntryDirectory, 'cli.js'),
    join(resolve(packageEntryDirectory, '..'), 'dist', 'cli.js'),
  ];

  for (const candidatePath of cliPathCandidates) {
    try {
      await access(candidatePath);
      return candidatePath;
    } catch {
      // continue
    }
  }

  throw new Error(`bundled pi CLI was not found (${cliPathCandidates.join(', ')}); reinstall jagc and retry`);
}
