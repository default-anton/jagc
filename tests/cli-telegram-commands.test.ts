import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { registerTelegramCommands } from '../src/cli/telegram-commands.js';

describe('registerTelegramCommands', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('allow adds user id to service.env and restarts service', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-telegram-allow-'));
    tempDirectories.push(workspaceDir);
    const serviceEnvPath = join(workspaceDir, 'service.env');
    await writeFile(serviceEnvPath, 'JAGC_LOG_LEVEL=info\nJAGC_TELEGRAM_ALLOWED_USER_IDS=101\n', 'utf8');

    const restartImpl = vi.fn().mockResolvedValue({
      running: true,
      pid: 123,
      label: 'com.jagc.server',
    });
    const createServiceManagerImpl = vi.fn().mockReturnValue({
      restart: restartImpl,
      install: vi.fn(),
      status: vi.fn(),
      uninstall: vi.fn(),
      platform: 'darwin',
    });

    const stdoutLines: string[] = [];
    const program = new Command();
    registerTelegramCommands(program, {
      createServiceManagerImpl: createServiceManagerImpl as never,
      writeStdoutImpl: (line) => stdoutLines.push(line),
    });

    await program.parseAsync(
      ['node', 'jagc', 'telegram', 'allow', '--workspace-dir', workspaceDir, '--user-id', '0202'],
      { from: 'node' },
    );

    const content = await readFile(serviceEnvPath, 'utf8');
    expect(content).toContain('JAGC_TELEGRAM_ALLOWED_USER_IDS=101,202');
    expect(restartImpl).toHaveBeenCalledWith({
      label: 'com.jagc.server',
      workspaceDir,
      launchctlDomain: undefined,
    });
    expect(stdoutLines).toContain('allowed telegram user 202');
  });

  test('allow keeps existing id without restart when --no-restart is set', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-telegram-allow-'));
    tempDirectories.push(workspaceDir);
    const serviceEnvPath = join(workspaceDir, 'service.env');
    const initialContent = 'JAGC_TELEGRAM_ALLOWED_USER_IDS=202\n';
    await writeFile(serviceEnvPath, initialContent, 'utf8');

    const restartImpl = vi.fn();
    const createServiceManagerImpl = vi.fn().mockReturnValue({
      restart: restartImpl,
      install: vi.fn(),
      status: vi.fn(),
      uninstall: vi.fn(),
      platform: 'darwin',
    });

    const stdoutLines: string[] = [];
    const program = new Command();
    registerTelegramCommands(program, {
      createServiceManagerImpl: createServiceManagerImpl as never,
      writeStdoutImpl: (line) => stdoutLines.push(line),
    });

    await program.parseAsync(
      ['node', 'jagc', 'telegram', 'allow', '--workspace-dir', workspaceDir, '--user-id', '00202', '--no-restart'],
      { from: 'node' },
    );

    const content = await readFile(serviceEnvPath, 'utf8');
    expect(content).toBe(initialContent);
    expect(restartImpl).not.toHaveBeenCalled();
    expect(stdoutLines).toContain('telegram user 202 is already allowed');
  });

  test('allow rewrites non-canonical existing allowlist values', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-telegram-allow-'));
    tempDirectories.push(workspaceDir);
    const serviceEnvPath = join(workspaceDir, 'service.env');
    await writeFile(serviceEnvPath, 'JAGC_TELEGRAM_ALLOWED_USER_IDS=000202,101\n', 'utf8');

    const createServiceManagerImpl = vi.fn().mockReturnValue({
      restart: vi.fn(),
      install: vi.fn(),
      status: vi.fn(),
      uninstall: vi.fn(),
      platform: 'darwin',
    });

    const stdoutLines: string[] = [];
    const program = new Command();
    registerTelegramCommands(program, {
      createServiceManagerImpl: createServiceManagerImpl as never,
      writeStdoutImpl: (line) => stdoutLines.push(line),
    });

    await program.parseAsync(
      ['node', 'jagc', 'telegram', 'allow', '--workspace-dir', workspaceDir, '--user-id', '202', '--no-restart'],
      { from: 'node' },
    );

    const content = await readFile(serviceEnvPath, 'utf8');
    expect(content).toContain('JAGC_TELEGRAM_ALLOWED_USER_IDS=202,101');
    expect(stdoutLines).toContain('telegram user 202 is already allowed');
  });

  test('list prints allowed ids from service.env', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-telegram-list-'));
    tempDirectories.push(workspaceDir);
    const serviceEnvPath = join(workspaceDir, 'service.env');
    await writeFile(serviceEnvPath, 'JAGC_TELEGRAM_ALLOWED_USER_IDS=00101,202,00202\n', 'utf8');

    const stdoutLines: string[] = [];
    const program = new Command();
    registerTelegramCommands(program, {
      writeStdoutImpl: (line) => stdoutLines.push(line),
    });

    await program.parseAsync(['node', 'jagc', 'telegram', 'list', '--workspace-dir', workspaceDir], { from: 'node' });

    expect(stdoutLines).toEqual([`allowed Telegram user ids (${serviceEnvPath}): 101, 202`]);
  });
});
