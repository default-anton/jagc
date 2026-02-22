import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';

import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { exitWithError, printJson } from './common.js';

const defaultWorkspaceDir = process.env.JAGC_WORKSPACE_DIR ?? join(homedir(), '.jagc');

interface DefaultsSyncCommandOptions {
  workspaceDir: string;
  json?: boolean;
}

interface DefaultsCommandsDependencies {
  bootstrapAgentDirImpl?: typeof bootstrapAgentDir;
  printJsonImpl?: typeof printJson;
  writeStdoutImpl?: (line: string) => void;
}

export function registerDefaultsCommands(program: Command, dependencies: DefaultsCommandsDependencies = {}): void {
  const bootstrapAgentDirImpl = dependencies.bootstrapAgentDirImpl ?? bootstrapAgentDir;
  const printJsonImpl = dependencies.printJsonImpl ?? printJson;
  const writeStdoutImpl = dependencies.writeStdoutImpl ?? ((line: string) => process.stdout.write(`${line}\n`));

  const defaultsCommand = program.command('defaults').description('manage bundled workspace defaults');

  defaultsCommand
    .command('sync')
    .description('sync latest bundled defaults/skills/extensions/memory into workspace without deleting user files')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--json', 'JSON output')
    .action(async (options: DefaultsSyncCommandOptions) => {
      try {
        const result = await bootstrapAgentDirImpl(options.workspaceDir, {
          overwriteBundledFiles: true,
          overwriteWorkspaceFiles: false,
        });

        if (options.json) {
          printJsonImpl({
            workspace_dir: options.workspaceDir,
            created_directory: result.createdDirectory,
            synced_files: result.createdFiles,
            synced_file_count: result.createdFiles.length,
            overwrite_bundled_files: true,
            overwrite_workspace_files: false,
          });
          return;
        }

        if (result.createdFiles.length === 0) {
          writeStdoutImpl(`defaults already up to date: ${options.workspaceDir}`);
          return;
        }

        writeStdoutImpl(`synced ${result.createdFiles.length} bundled default file(s): ${options.workspaceDir}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}
