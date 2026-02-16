import { type Command, Option } from 'commander';
import {
  type ApiRunNowTaskResponse,
  type ApiRunResponse,
  type ApiTaskResponse,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  runTaskNow,
  updateTask,
  waitForRun,
} from './client.js';
import { exitWithError, parsePositiveNumber, printJson } from './common.js';

const fallbackThreadKey = 'cli:default';
const taskThreadKeyEnvVar = 'JAGC_THREAD_KEY';

type TaskStateFilter = 'all' | 'enabled' | 'disabled';

interface RegisterTaskCommandsDependencies {
  createTaskImpl?: typeof createTask;
  listTasksImpl?: typeof listTasks;
  getTaskImpl?: typeof getTask;
  updateTaskImpl?: typeof updateTask;
  deleteTaskImpl?: typeof deleteTask;
  runTaskNowImpl?: typeof runTaskNow;
  waitForRunImpl?: typeof waitForRun;
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
  const waitForRunImpl = dependencies.waitForRunImpl ?? waitForRun;
  const printJsonImpl = dependencies.printJsonImpl ?? printJson;
  const writeStdoutImpl = dependencies.writeStdoutImpl ?? ((line: string) => process.stdout.write(`${line}\n`));
  const defaultThreadKey = resolveDefaultTaskThreadKey();

  const taskCommand = program.command('task').description('manage scheduled tasks');

  taskCommand
    .command('create')
    .description('create a scheduled task')
    .requiredOption('--title <text>', 'task title')
    .requiredOption('--instructions <text>', 'task instructions')
    .option('--once-at <timestamp>', 'one-off schedule timestamp (ISO-8601 UTC)')
    .option('--cron <expr>', 'cron expression (5 fields)')
    .option('--rrule <rule>', 'RRULE expression (for example FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1)')
    .option('--timezone <iana>', 'IANA timezone (for example America/Los_Angeles)')
    .option(
      '--thread-key <threadKey>',
      'creator thread key (defaults to $JAGC_THREAD_KEY when set, else cli:default)',
      defaultThreadKey,
    )
    .option('--json', 'JSON output')
    .addHelpText(
      'after',
      '\nExample (every 2 weeks on Monday at 09:00):\n  jagc task create --title "Biweekly sync" --instructions "Prepare sync agenda" --rrule "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0" --timezone "America/Los_Angeles" --json\n',
    )
    .action(async (options) => {
      try {
        const schedule = buildScheduleFromOptions({
          onceAt: options.onceAt,
          cronExpr: options.cron,
          rruleExpr: options.rrule,
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
        exitWithError(error, { json: options.json });
      }
    });

  taskCommand
    .command('list')
    .description('list scheduled tasks')
    .option('--thread-key <threadKey>', 'filter by creator thread key')
    .addOption(
      new Option('--state <state>', 'task state filter').choices(['all', 'enabled', 'disabled']).default('all'),
    )
    .option('--json', 'JSON output')
    .action(async (options: { threadKey?: string; state: TaskStateFilter; json?: boolean }) => {
      try {
        const response = await listTasksImpl(apiUrl(program), {
          threadKey: options.threadKey,
          state: options.state,
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
        exitWithError(error, { json: options.json });
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
        exitWithError(error, { json: options.json });
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
    .option('--rrule <rule>', 'set RRULE expression')
    .option('--timezone <iana>', 'timezone for --once-at/--cron/--rrule schedule updates')
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
          rruleExpr: options.rrule,
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
        exitWithError(error, { json: options.json });
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
        exitWithError(error, { json: options.json });
      }
    });

  taskCommand
    .command('run')
    .description('run a task immediately')
    .argument('<taskId>', 'task id')
    .option('--wait', 'wait for terminal run status')
    .option('--timeout <seconds>', 'wait timeout in seconds (requires --wait)', parsePositiveNumber)
    .option('--interval-ms <ms>', 'poll interval milliseconds (requires --wait)', parsePositiveNumber)
    .option('--json', 'JSON output')
    .action(async (taskId, options: { wait?: boolean; timeout?: number; intervalMs?: number; json?: boolean }) => {
      try {
        if (!options.wait && (options.timeout !== undefined || options.intervalMs !== undefined)) {
          throw new Error('task run --timeout and --interval-ms require --wait');
        }

        const response = await runTaskNowImpl(apiUrl(program), taskId);

        if (!options.wait) {
          if (options.json) {
            printJsonImpl(response);
            return;
          }

          writeStdoutImpl(formatTaskRunNowSummary(response));
          return;
        }

        if (!response.task_run.run_id) {
          throw new Error('task run did not return run_id; retry without --wait and inspect task run state');
        }

        const run = await waitForRunImpl(
          apiUrl(program),
          response.task_run.run_id,
          (options.timeout ?? 60) * 1000,
          options.intervalMs ?? 500,
        );

        if (options.json) {
          printJsonImpl({
            task: response.task,
            task_run: response.task_run,
            run,
          });
          return;
        }

        writeStdoutImpl(formatTaskRunNowSummary(response, run));
      } catch (error) {
        exitWithError(error, { json: options.json });
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
        exitWithError(error, { json: options.json });
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
        exitWithError(error, { json: options.json });
      }
    });
}

function apiUrl(root: Command): string {
  return root.opts<{ apiUrl: string }>().apiUrl;
}

function resolveDefaultTaskThreadKey(env: NodeJS.ProcessEnv = process.env): string {
  const configuredThreadKey = env[taskThreadKeyEnvVar]?.trim();
  if (configuredThreadKey) {
    return configuredThreadKey;
  }

  return fallbackThreadKey;
}

function buildScheduleFromOptions(input: { onceAt?: string; cronExpr?: string; rruleExpr?: string; timezone?: string }):
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
  | {
      kind: 'rrule';
      rrule: string;
      timezone: string;
    } {
  const selectedScheduleFlags = [input.onceAt, input.cronExpr, input.rruleExpr].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  if (selectedScheduleFlags.length > 1) {
    throw new Error('task create accepts only one of --once-at, --cron, or --rrule');
  }

  if (selectedScheduleFlags.length === 0) {
    throw new Error('task create requires one of --once-at, --cron, or --rrule');
  }

  if (!input.timezone) {
    throw new Error('task create requires --timezone when using --once-at, --cron, or --rrule');
  }

  if (input.onceAt) {
    return {
      kind: 'once',
      once_at: input.onceAt,
      timezone: input.timezone,
    };
  }

  if (input.cronExpr) {
    return {
      kind: 'cron',
      cron: input.cronExpr,
      timezone: input.timezone,
    };
  }

  return {
    kind: 'rrule',
    rrule: input.rruleExpr as string,
    timezone: input.timezone,
  };
}

function buildOptionalScheduleFromOptions(input: {
  onceAt?: string;
  cronExpr?: string;
  rruleExpr?: string;
  timezone?: string;
}):
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
  | {
      kind: 'rrule';
      rrule: string;
      timezone: string;
    }
  | undefined {
  if (!input.onceAt && !input.cronExpr && !input.rruleExpr && !input.timezone) {
    return undefined;
  }

  if (input.timezone && !input.onceAt && !input.cronExpr && !input.rruleExpr) {
    throw new Error('task update timezone changes require --once-at, --cron, or --rrule');
  }

  return buildScheduleFromOptions(input);
}

function formatTaskSummary(response: ApiTaskResponse): string {
  const task = response.task;
  const schedule =
    task.schedule.kind === 'once'
      ? `once@${task.schedule.once_at}`
      : task.schedule.kind === 'cron'
        ? `cron:${task.schedule.cron}`
        : `rrule:${formatRRuleSummary(task.schedule.rrule)}`;
  return `${task.task_id} ${task.enabled ? 'enabled' : 'disabled'} ${schedule} ${task.title}`;
}

function formatRRuleSummary(value: string | null): string {
  if (!value) {
    return '(missing)';
  }

  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= 72) {
    return compact;
  }

  return `${compact.slice(0, 69)}...`;
}

function formatTaskRunNowSummary(response: ApiRunNowTaskResponse, run?: ApiRunResponse): string {
  if (!run) {
    return `task:${response.task.task_id} run:${response.task_run.task_run_id} status:${response.task_run.status}`;
  }

  if (run.error?.message) {
    return `task:${response.task.task_id} run:${response.task_run.task_run_id} status:${run.status} error:${run.error.message}`;
  }

  return `task:${response.task.task_id} run:${response.task_run.task_run_id} status:${run.status}`;
}
