import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { registerTaskCommands } from '../src/cli/task-commands.js';

describe('registerTaskCommands', () => {
  const initialTaskThreadEnv = process.env.JAGC_THREAD_KEY;

  afterEach(() => {
    vi.restoreAllMocks();

    if (initialTaskThreadEnv === undefined) {
      delete process.env.JAGC_THREAD_KEY;
      return;
    }

    process.env.JAGC_THREAD_KEY = initialTaskThreadEnv;
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
          rrule: null,
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

  test('create defaults thread key from JAGC_THREAD_KEY when set', async () => {
    process.env.JAGC_THREAD_KEY = 'telegram:chat:101:topic:333';

    const createTaskImpl = vi.fn().mockResolvedValue({
      task: {
        task_id: 'task-telegram',
        title: 'Topic task',
        instructions: 'Stay in current telegram thread',
        schedule: {
          kind: 'once',
          cron: null,
          once_at: '2026-02-16T00:00:00.000Z',
          rrule: null,
          timezone: 'UTC',
        },
        enabled: true,
        next_run_at: '2026-02-16T00:00:00.000Z',
        creator_thread_key: 'telegram:chat:101:topic:333',
        owner_user_key: null,
        delivery_target: {
          provider: 'telegram',
        },
        execution_thread_key: null,
        created_at: '2026-02-15T00:00:00.000Z',
        updated_at: '2026-02-15T00:00:00.000Z',
        last_run_at: null,
        last_run_status: null,
        last_error_message: null,
      },
    });

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      createTaskImpl,
    });

    await program.parseAsync(
      [
        'node',
        'jagc',
        'task',
        'create',
        '--title',
        'Topic task',
        '--instructions',
        'Stay in current telegram thread',
        '--once-at',
        '2026-02-16T00:00:00.000Z',
        '--timezone',
        'UTC',
      ],
      { from: 'node' },
    );

    expect(createTaskImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'telegram:chat:101:topic:333', {
      title: 'Topic task',
      instructions: 'Stay in current telegram thread',
      schedule: {
        kind: 'once',
        once_at: '2026-02-16T00:00:00.000Z',
        timezone: 'UTC',
      },
    });
  });

  test('create supports rrule schedule payload', async () => {
    const createTaskImpl = vi.fn().mockResolvedValue({
      task: {
        task_id: 'task-rrule',
        title: 'First Monday',
        instructions: 'Monthly priorities',
        schedule: {
          kind: 'rrule',
          cron: null,
          once_at: null,
          rrule:
            'DTSTART;TZID=UTC:20260101T000000\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
          timezone: 'UTC',
        },
        enabled: true,
        next_run_at: '2026-02-02T09:00:00.000Z',
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

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      createTaskImpl,
    });

    await program.parseAsync(
      [
        'node',
        'jagc',
        'task',
        'create',
        '--title',
        'First Monday',
        '--instructions',
        'Monthly priorities',
        '--rrule',
        'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        '--timezone',
        'UTC',
      ],
      { from: 'node' },
    );

    expect(createTaskImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'cli:default', {
      title: 'First Monday',
      instructions: 'Monthly priorities',
      schedule: {
        kind: 'rrule',
        rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        timezone: 'UTC',
      },
    });
  });

  test('list defaults to all state filter', async () => {
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
      state: 'all',
    });
    expect(lines).toEqual(['no tasks found']);
  });

  test('run executes immediately without --now', async () => {
    const runTaskNowImpl = vi.fn().mockResolvedValue({
      task: {
        task_id: 'task-1',
      },
      task_run: {
        task_run_id: 'task-run-1',
        status: 'dispatched',
      },
    });

    const lines: string[] = [];
    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      runTaskNowImpl: runTaskNowImpl as never,
      writeStdoutImpl: (line) => lines.push(line),
    });

    await program.parseAsync(['node', 'jagc', 'task', 'run', 'task-1'], { from: 'node' });

    expect(runTaskNowImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'task-1');
    expect(lines).toEqual(['task:task-1 run:task-run-1 status:dispatched']);
  });

  test('run --wait waits for terminal run status and prints JSON bundle', async () => {
    const runTaskNowImpl = vi.fn().mockResolvedValue({
      task: {
        task_id: 'task-1',
      },
      task_run: {
        task_run_id: 'task-run-1',
        run_id: 'run-1',
        status: 'dispatched',
      },
    });
    const waitForRunImpl = vi.fn().mockResolvedValue({
      run_id: 'run-1',
      status: 'succeeded',
      output: {
        type: 'message',
        text: 'ok',
      },
      error: null,
    });
    const printJsonImpl = vi.fn();

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      runTaskNowImpl: runTaskNowImpl as never,
      waitForRunImpl: waitForRunImpl as never,
      printJsonImpl,
    });

    await program.parseAsync(
      ['node', 'jagc', 'task', 'run', 'task-1', '--wait', '--timeout', '10', '--interval-ms', '100', '--json'],
      { from: 'node' },
    );

    expect(runTaskNowImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'task-1');
    expect(waitForRunImpl).toHaveBeenCalledWith('http://127.0.0.1:31415', 'run-1', 10_000, 100);
    expect(printJsonImpl).toHaveBeenCalledWith({
      task: {
        task_id: 'task-1',
      },
      task_run: {
        task_run_id: 'task-run-1',
        run_id: 'run-1',
        status: 'dispatched',
      },
      run: {
        run_id: 'run-1',
        status: 'succeeded',
        output: {
          type: 'message',
          text: 'ok',
        },
        error: null,
      },
    });
  });

  test('run emits JSON error envelope when --json is set', async () => {
    const runTaskNowImpl = vi.fn();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process-exit:${code ?? ''}`);
    }) as never);

    const program = new Command();
    program.option('--api-url <url>', 'api', 'http://127.0.0.1:31415');
    registerTaskCommands(program, {
      runTaskNowImpl: runTaskNowImpl as never,
    });

    await expect(
      program.parseAsync(['node', 'jagc', 'task', 'run', 'task-1', '--timeout', '2', '--json'], { from: 'node' }),
    ).rejects.toThrow('process-exit:1');

    expect(runTaskNowImpl).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ error: { message: 'task run --timeout and --interval-ms require --wait' } })}\n`,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
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
