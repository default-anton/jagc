import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { registerTaskCommands } from '../src/cli/task-commands.js';

describe('registerTaskCommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('create forwards schedule payload and prints JSON', async () => {
    const createTaskImpl = vi.fn().mockResolvedValue({
      task: {
        task_id: 'task-1',
        title: 'Daily plan',
        instructions: 'Prepare plan',
        schedule: {
          kind: 'cron',
          cron: '0 9 * * 1-5',
          once_at: null,
          timezone: 'America/Los_Angeles',
        },
        enabled: true,
        next_run_at: '2026-02-16T17:00:00.000Z',
        creator_thread_key: 'cli:default',
        owner_user_key: null,
        delivery_target: {
          provider: 'cli',
        },
        execution_thread_key: null,
        created_at: '2026-02-15T00:00:00.000Z',
        updated_at: '2026-02-15T00:00:00.000Z',
        last_run_at: null,
        last_run_status: null,
        last_error_message: null,
      },
    });
    const printJsonImpl = vi.fn();

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      createTaskImpl,
      printJsonImpl,
    });

    await program.parseAsync(
      [
        'node',
        'jagc',
        'task',
        'create',
        '--title',
        'Daily plan',
        '--instructions',
        'Prepare plan',
        '--cron',
        '0 9 * * 1-5',
        '--timezone',
        'America/Los_Angeles',
        '--json',
      ],
      { from: 'node' },
    );

    expect(createTaskImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'cli:default', {
      title: 'Daily plan',
      instructions: 'Prepare plan',
      schedule: {
        kind: 'cron',
        cron: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
      },
    });
    expect(printJsonImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ task_id: 'task-1' }),
      }),
    );
  });

  test('list defaults to enabled filter', async () => {
    const listTasksImpl = vi.fn().mockResolvedValue({ tasks: [] });

    const lines: string[] = [];
    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      listTasksImpl,
      writeStdoutImpl: (line) => lines.push(line),
    });

    await program.parseAsync(['node', 'jagc', 'task', 'list'], { from: 'node' });

    expect(listTasksImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', {
      threadKey: undefined,
      state: 'enabled',
    });
    expect(lines).toEqual(['no tasks found']);
  });

  test('update validates patch flags and exits with error for empty patch', async () => {
    const updateTaskImpl = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process-exit:${code ?? ''}`);
    }) as never);

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      updateTaskImpl,
    });

    await expect(program.parseAsync(['node', 'jagc', 'task', 'update', 'task-1'], { from: 'node' })).rejects.toThrow(
      'process-exit:1',
    );

    expect(updateTaskImpl).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('task update requires at least one patch flag'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
