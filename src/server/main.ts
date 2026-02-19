import { TelegramPollingAdapter } from '../adapters/telegram-polling.js';
import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { PiAuthService } from '../runtime/pi-auth.js';
import { PiRunExecutor, type ThreadControlService } from '../runtime/pi-executor.js';
import { loadConfig } from '../shared/config.js';
import { createLogger, resolveLogLevel } from '../shared/logger.js';
import { createApp } from './app.js';
import { applyNodeEnvFileOverrides } from './env-file-overrides.js';
import { EchoRunExecutor, type RunExecutor } from './executor.js';
import { runMigrations } from './migrations.js';
import { ScheduledTaskService } from './scheduled-task-service.js';
import { SqliteScheduledTaskStore } from './scheduled-task-store.js';
import { LocalRunScheduler } from './scheduler.js';
import { RunService } from './service.js';
import { openSqliteDatabase } from './sqlite.js';
import { SqliteRunStore } from './store.js';

async function main(): Promise<void> {
  applyNodeEnvFileOverrides();

  const config = loadConfig();
  const rootLogger = createLogger({
    level: config.JAGC_LOG_LEVEL,
    bindings: {
      service: 'jagc',
    },
  });
  const mainLogger = rootLogger.child({ component: 'server_main' });

  const overwriteDevDefaults = process.env.JAGC_DEV_OVERWRITE_DEFAULTS === '1';
  const bootstrapResult = await bootstrapAgentDir(config.JAGC_WORKSPACE_DIR, {
    overwriteBundledFiles: overwriteDevDefaults,
    overwriteWorkspaceFiles: overwriteDevDefaults,
    overwriteWorkspaceFilesExclude: ['settings.json'],
  });
  if (bootstrapResult.createdDirectory || bootstrapResult.createdFiles.length > 0) {
    mainLogger.info({
      event: 'workspace_bootstrap',
      workspace_dir: config.JAGC_WORKSPACE_DIR,
      created_directory: bootstrapResult.createdDirectory,
      created_files: bootstrapResult.createdFiles,
    });
  }

  const database = openSqliteDatabase(config.JAGC_DATABASE_PATH);

  await runMigrations(database);

  const runStore = new SqliteRunStore(database, rootLogger.child({ component: 'run_store' }));

  let runExecutor: RunExecutor;
  let threadControlService: ThreadControlService | undefined;

  if (config.JAGC_RUNNER === 'echo') {
    runExecutor = new EchoRunExecutor();
  } else {
    const piRunExecutor = new PiRunExecutor(runStore, {
      workspaceDir: config.JAGC_WORKSPACE_DIR,
      logger: rootLogger.child({ component: 'run_executor' }),
      telegramBotToken: config.JAGC_TELEGRAM_BOT_TOKEN,
    });

    runExecutor = piRunExecutor;
    threadControlService = piRunExecutor;
  }

  let runService: RunService | undefined;
  const runScheduler = new LocalRunScheduler({
    dispatchRunById: async (runId) => {
      if (!runService) {
        throw new Error('run service is not initialized');
      }

      await runService.dispatchRunById(runId);
    },
    logger: rootLogger.child({ component: 'run_scheduler' }),
  });

  runService = new RunService(runStore, runExecutor, runScheduler, rootLogger.child({ component: 'run_service' }));
  await runService.init();

  const authService = new PiAuthService(config.JAGC_WORKSPACE_DIR);

  let scheduledTaskService: ScheduledTaskService;

  let telegramAdapter: TelegramPollingAdapter | undefined;
  if (config.JAGC_TELEGRAM_BOT_TOKEN) {
    telegramAdapter = new TelegramPollingAdapter({
      botToken: config.JAGC_TELEGRAM_BOT_TOKEN,
      runService,
      authService,
      threadControlService,
      clearScheduledTaskExecutionThreadByKey: async (threadKey) =>
        scheduledTaskService.clearExecutionThreadByThreadKey(threadKey),
      allowedTelegramUserIds: config.JAGC_TELEGRAM_ALLOWED_USER_IDS,
      workspaceDir: config.JAGC_WORKSPACE_DIR,
      logger: rootLogger.child({ component: 'telegram_polling' }),
    });
  }

  const scheduledTaskStore = new SqliteScheduledTaskStore(database);
  scheduledTaskService = new ScheduledTaskService(scheduledTaskStore, runService, {
    logger: rootLogger.child({ component: 'scheduled_tasks' }),
    telegramBridge: {
      createTaskTopic: async ({ chatId, taskId, title }) => {
        if (!telegramAdapter) {
          throw new Error(
            'telegram_topics_unavailable: Telegram adapter is not configured; set JAGC_TELEGRAM_BOT_TOKEN and restart',
          );
        }

        return telegramAdapter.createTaskTopic({ chatId, taskId, title });
      },
      syncTaskTopicTitle: async (route, taskId, title) => {
        if (!telegramAdapter) {
          throw new Error(
            'telegram_topics_unavailable: Telegram adapter is not configured; set JAGC_TELEGRAM_BOT_TOKEN and restart',
          );
        }

        await telegramAdapter.syncTaskTopicTitle(route, taskId, title);
      },
      deliverRun: async (runId, route) => {
        if (!telegramAdapter) {
          throw new Error(
            'telegram_topics_unavailable: Telegram adapter is not configured; set JAGC_TELEGRAM_BOT_TOKEN and restart',
          );
        }

        await telegramAdapter.deliverRun(runId, route);
      },
    },
  });

  const app = createApp({
    runService,
    authService,
    threadControlService,
    scheduledTaskService,
    logger: rootLogger.child({ component: 'http_server' }),
  });

  let closePromise: Promise<void> | null = null;
  const close = async (signal?: string) => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      mainLogger.info({ event: 'server_shutdown_started', signal: signal ?? null });
      await scheduledTaskService.stop();
      await telegramAdapter?.stop();
      await app.close();
      await runService.shutdown();
      database.close();
      mainLogger.info({ event: 'server_shutdown_completed', signal: signal ?? null });
    })();

    return closePromise;
  };

  process.once('SIGINT', () => {
    void close('SIGINT').finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void close('SIGTERM').finally(() => process.exit(0));
  });

  await app.listen({
    port: config.JAGC_PORT,
    host: config.JAGC_HOST,
  });

  mainLogger.info({
    event: 'server_listening',
    host: config.JAGC_HOST,
    port: config.JAGC_PORT,
  });

  if (telegramAdapter) {
    await telegramAdapter.start();
  }

  await scheduledTaskService.start();
}

const startupLogger = createLogger({
  level: resolveLogLevel(process.env.JAGC_LOG_LEVEL),
  bindings: {
    service: 'jagc',
    component: 'server_main',
  },
});

main().catch((error) => {
  startupLogger.error({
    event: 'server_main_failed',
    err: error instanceof Error ? error : new Error(String(error)),
  });
  process.exit(1);
});
