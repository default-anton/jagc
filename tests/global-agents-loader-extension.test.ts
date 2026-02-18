import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import globalAgentsLoaderExtension from '../defaults/extensions/30-global-agents-loader.js';

type BeforeAgentStartHandler = (
  event: { systemPrompt: string },
  ctx: { cwd: string },
) => Promise<{ systemPrompt: string } | undefined>;

describe('globalAgentsLoaderExtension', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test('injects global AGENTS path and agents_files payload without duplicated policy text', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-global-agents-loader-'));
    tempDirs.push(workspaceDir);

    const globalAgentsPath = join(workspaceDir, 'AGENTS.md');
    await writeFile(globalAgentsPath, '# AGENTS\n\n- Call me Anton.\n');

    let handler: BeforeAgentStartHandler | undefined;

    globalAgentsLoaderExtension({
      on: (event, registeredHandler) => {
        expect(event).toBe('before_agent_start');
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.({ systemPrompt: 'Base system prompt.' }, { cwd: workspaceDir });

    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain(`Global AGENTS.md: ${globalAgentsPath} (applies to all projects)`);
    expect(result?.systemPrompt).toContain('AGENTS.md files:');
    expect(result?.systemPrompt).toContain('<agents_files>');
    expect(result?.systemPrompt).toContain(`<agent_file path="${globalAgentsPath}">`);
    expect(result?.systemPrompt).toContain('# AGENTS\n\n- Call me Anton.');
    expect(result?.systemPrompt).not.toContain('Global AGENTS.md purpose:');
    expect(result?.systemPrompt).not.toContain('defines baseline instructions that apply across chats and projects');
  });

  test('does not inject when global AGENTS.md is missing', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-global-agents-loader-'));
    tempDirs.push(workspaceDir);

    let handler: BeforeAgentStartHandler | undefined;

    globalAgentsLoaderExtension({
      on: (_event, registeredHandler) => {
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.({ systemPrompt: 'Base system prompt.' }, { cwd: workspaceDir });

    expect(result).toBeUndefined();
  });

  test('does not inject when agents_files payload already exists', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-global-agents-loader-'));
    tempDirs.push(workspaceDir);

    const globalAgentsPath = join(workspaceDir, 'AGENTS.md');
    await writeFile(globalAgentsPath, '# AGENTS\n\n- Call me Anton.\n');

    let handler: BeforeAgentStartHandler | undefined;

    globalAgentsLoaderExtension({
      on: (_event, registeredHandler) => {
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.(
      { systemPrompt: 'Base system prompt.\n\n<agents_files>\n</agents_files>' },
      { cwd: workspaceDir },
    );

    expect(result).toBeUndefined();
  });
});
