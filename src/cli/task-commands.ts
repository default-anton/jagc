import type { Command } from 'commander';
import {
  type ApiRunNowTaskResponse,
  type ApiTaskResponse,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  runTaskNow,
  updateTask,
} from './client.js';
import { exitWithError, printJson } from './common.js';

const defaultThreadKey = 'cli:default';

type TaskStateFilter = 'all' | 'enabled' | 'disabled';

interface RegisterTaskCommandsDependencies {
  createTaskImpl?: typeof createTask;
  listTasksImpl?: typeof listTasks;
  getTaskImpl?: typeof getTask;
  updateTaskImpl?: typeof updateTask;
  deleteTaskImpl?: typeof deleteTask;
  runTaskNowImpl?: typeof runTaskNow;
  printJsonImpl?: typeof printJson;
  writeStdoutImpl?: (line: string) => void;
}

export function registerTaskCommands(program: Command, dependencies: RegisterTaskCommandsDependencies = {}): void {
  const createTaskImpl = dependencies.createTaskImpl ?? createTask;
  const listTasksImpl = dependencies.listTasksImpl ?? listTasks;
  const getTaskImpl = dependencies.getTaskImpl ?? getTask;
  const updateTaskImpl = dependencies.updateTaskImpl ?? updateTask;
  const deleteTaskImpl = dependencies.deleteTaskImpl ?? deleteTask;
  const runTaskNowImpl = dependencies.runTaskNowImpl ?? runTaskNow;
  const printJsonImpl = dependencies.printJsonImpl ?? printJson;
  const writeStdoutImpl = dependencies.writeStdoutImpl ?? ((line: string) => process.stdout.write(`${line}\n`));

  const taskCommand = program.command('task').description('manage scheduled tasks');

  taskCommand
    .command('create')
    .description('create a scheduled task')
    .requiredOption('--title <text>', 'task title')
    .requiredOption('--instructions <text>', 'task instructions')
    .option('--once-at <timestamp>', 'one-off schedule timestamp (ISO-8601 UTC)')
    .option('--cron <expr>', 'cron expression (5 fields)')
    .option('--timezone <iana>', 'IANA timezone (for example America/Los_Angeles)')
    .option('--thread-key <threadKey>', 'creator thread key', defaultThreadKey)
    .option('--json', 'JSON output')
    .action(async (options) => {
      try {
        const schedule = buildScheduleFromOptions({
          onceAt: options.onceAt,
          cronExpr: options.cron,
          timezone: options.timezone,
        });

        const response = await createTaskImpl(apiUrl(program), options.threadKey, {
          title: options.title,
          instructions: options.instructions,
          schedule,
        });

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(`created ${formatTaskSummary(response)}`);
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('list')
    .description('list scheduled tasks')
    .option('--thread-key <threadKey>', 'filter by creator thread key')
    .option('--all', 'list all tasks')
    .option('--enabled', 'list enabled tasks (default)')
    .option('--disabled', 'list disabled tasks')
    .option('--json', 'JSON output')
    .action(async (options) => {
      try {
        const state = parseTaskStateFilter(options);
        const response = await listTasksImpl(apiUrl(program), {
          threadKey: options.threadKey,
          state,
        });

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        if (response.tasks.length === 0) {
          writeStdoutImpl('no tasks found');
          return;
        }

        for (const task of response.tasks) {
          writeStdoutImpl(`${task.task_id} ${task.enabled ? 'enabled' : 'disabled'} ${task.title}`);
        }
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('get')
    .description('show task details')
    .argument('<taskId>', 'task id')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        const response = await getTaskImpl(apiUrl(program), taskId);

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(formatTaskSummary(response));
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('update')
    .description('update task fields')
    .argument('<taskId>', 'task id')
    .option('--title <text>', 'updated task title')
    .option('--instructions <text>', 'updated task instructions')
    .option('--once-at <timestamp>', 'set one-off schedule timestamp (ISO-8601 UTC)')
    .option('--cron <expr>', 'set cron expression (5 fields)')
    .option('--timezone <iana>', 'timezone for --once-at/--cron schedule updates')
    .option('--enable', 'enable task')
    .option('--disable', 'disable task')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        if (options.enable && options.disable) {
          throw new Error('task update accepts only one of --enable or --disable');
        }

        const schedule = buildOptionalScheduleFromOptions({
          onceAt: options.onceAt,
          cronExpr: options.cron,
          timezone: options.timezone,
        });

        const payload = {
          title: options.title,
          instructions: options.instructions,
          enabled: options.enable ? true : options.disable ? false : undefined,
          schedule,
        };

        if (
          payload.title === undefined &&
          payload.instructions === undefined &&
          payload.enabled === undefined &&
          payload.schedule === undefined
        ) {
          throw new Error('task update requires at least one patch flag');
        }

        const response = await updateTaskImpl(apiUrl(program), taskId, payload);

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(`updated ${formatTaskSummary(response)}`);
        for (const warning of response.warnings ?? []) {
          writeStdoutImpl(`warning: ${warning}`);
        }
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('delete')
    .description('delete a task')
    .argument('<taskId>', 'task id')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        const response = await deleteTaskImpl(apiUrl(program), taskId);

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(`deleted task ${taskId}`);
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('run')
    .description('run a task immediately')
    .argument('<taskId>', 'task id')
    .option('--now', 'run now (required)')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        if (!options.now) {
          throw new Error('task run currently requires --now');
        }

        const response = await runTaskNowImpl(apiUrl(program), taskId);

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(formatTaskRunNowSummary(response));
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('enable')
    .description('enable a task')
    .argument('<taskId>', 'task id')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        const response = await updateTaskImpl(apiUrl(program), taskId, {
          enabled: true,
        });

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(`enabled ${formatTaskSummary(response)}`);
      } catch (error) {
        exitWithError(error);
      }
    });

  taskCommand
    .command('disable')
    .description('disable a task')
    .argument('<taskId>', 'task id')
    .option('--json', 'JSON output')
    .action(async (taskId, options) => {
      try {
        const response = await updateTaskImpl(apiUrl(program), taskId, {
          enabled: false,
        });

        if (options.json) {
          printJsonImpl(response);
          return;
        }

        writeStdoutImpl(`disabled ${formatTaskSummary(response)}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

function apiUrl(root: Command): string {
  return root.opts<{ apiUrl: string }>().apiUrl;
}

function parseTaskStateFilter(options: { all?: boolean; enabled?: boolean; disabled?: boolean }): TaskStateFilter {
  const enabledFilterCount = [options.all, options.enabled, options.disabled].filter(Boolean).length;
  if (enabledFilterCount > 1) {
    throw new Error('task list accepts only one of --all, --enabled, or --disabled');
  }

  if (options.all) {
    return 'all';
  }

  if (options.disabled) {
    return 'disabled';
  }

  return 'enabled';
}

function buildScheduleFromOptions(input: { onceAt?: string; cronExpr?: string; timezone?: string }):
  | {
      kind: 'once';
      once_at: string;
      timezone: string;
    }
  | {
      kind: 'cron';
      cron: string;
      timezone: string;
    } {
  if (input.onceAt && input.cronExpr) {
    throw new Error('task create accepts only one of --once-at or --cron');
  }

  if (!input.onceAt && !input.cronExpr) {
    throw new Error('task create requires either --once-at or --cron');
  }

  if (!input.timezone) {
    throw new Error('task create requires --timezone when using --once-at or --cron');
  }

  if (input.onceAt) {
    return {
      kind: 'once',
      once_at: input.onceAt,
      timezone: input.timezone,
    };
  }

  return {
    kind: 'cron',
    cron: input.cronExpr as string,
    timezone: input.timezone,
  };
}

function buildOptionalScheduleFromOptions(input: { onceAt?: string; cronExpr?: string; timezone?: string }):
  | {
      kind: 'once';
      once_at: string;
      timezone: string;
    }
  | {
      kind: 'cron';
      cron: string;
      timezone: string;
    }
  | undefined {
  if (!input.onceAt && !input.cronExpr && !input.timezone) {
    return undefined;
  }

  if (input.timezone && !input.onceAt && !input.cronExpr) {
    throw new Error('task update timezone changes require either --once-at or --cron');
  }

  return buildScheduleFromOptions(input);
}

function formatTaskSummary(response: ApiTaskResponse): string {
  const task = response.task;
  const schedule = task.schedule.kind === 'once' ? `once@${task.schedule.once_at}` : `cron:${task.schedule.cron}`;
  return `${task.task_id} ${task.enabled ? 'enabled' : 'disabled'} ${schedule} ${task.title}`;
}

function formatTaskRunNowSummary(response: ApiRunNowTaskResponse): string {
  return `task:${response.task.task_id} run:${response.task_run.task_run_id} status:${response.task_run.status}`;
}
