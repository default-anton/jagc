import { Command } from 'commander';
import { describe, expect, test, vi } from 'vitest';

import { registerDefaultsCommands } from '../src/cli/defaults-commands.js';

describe('registerDefaultsCommands', () => {
  test('sync calls bootstrap with bundled overwrite and preserves workspace files', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: ['extensions/10-codex-harness.ts'],
    });
    const printJsonImpl = vi.fn();

    const program = new Command();
    registerDefaultsCommands(program, {
      bootstrapAgentDirImpl,
      printJsonImpl,
    });

    await program.parseAsync(['node', 'jagc', 'defaults', 'sync', '--workspace-dir', '/tmp/jagc-workspace', '--json'], {
      from: 'node',
    });

    expect(bootstrapAgentDirImpl).toHaveBeenCalledWith('/tmp/jagc-workspace', {
      overwriteBundledFiles: true,
      overwriteWorkspaceFiles: false,
    });
    expect(printJsonImpl).toHaveBeenCalledWith({
      workspace_dir: '/tmp/jagc-workspace',
      created_directory: false,
      synced_files: ['extensions/10-codex-harness.ts'],
      synced_file_count: 1,
      overwrite_bundled_files: true,
      overwrite_workspace_files: false,
    });
  });

  test('sync prints up-to-date message when no files changed', async () => {
    const bootstrapAgentDirImpl = vi.fn().mockResolvedValue({
      createdDirectory: false,
      createdFiles: [],
    });
    const lines: string[] = [];

    const program = new Command();
    registerDefaultsCommands(program, {
      bootstrapAgentDirImpl,
      writeStdoutImpl: (line) => {
        lines.push(line);
      },
    });

    await program.parseAsync(['node', 'jagc', 'defaults', 'sync', '--workspace-dir', '/tmp/jagc-workspace'], {
      from: 'node',
    });

    expect(lines).toEqual(['defaults already up to date: /tmp/jagc-workspace']);
  });
});
