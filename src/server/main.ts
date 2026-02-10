import { TelegramPollingAdapter } from '../adapters/telegram-polling.js';
import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { PiAuthService } from '../runtime/pi-auth.js';
import { PiRunExecutor, type ThreadControlService } from '../runtime/pi-executor.js';
import { loadConfig } from '../shared/config.js';
import { createLogger, resolveLogLevel } from '../shared/logger.js';
import { createApp } from './app.js';
import { EchoRunExecutor, type RunExecutor } from './executor.js';
import { runMigrations } from './migrations.js';
import { LocalRunScheduler } from './scheduler.js';
import { RunService } from './service.js';
import { openSqliteDatabase } from './sqlite.js';
import { SqliteRunStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const rootLogger = createLogger({
    level: config.JAGC_LOG_LEVEL,
    bindings: {
      service: 'jagc',
    },
  });
  const mainLogger = rootLogger.child({ component: 'server_main' });

  const bootstrapResult = await bootstrapAgentDir(config.JAGC_WORKSPACE_DIR, {
    overwriteExistingFiles: process.env.JAGC_DEV_OVERWRITE_DEFAULTS === '1',
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

  const runStore = new SqliteRunStore(database);

  let runExecutor: RunExecutor;
  let threadControlService: ThreadControlService | undefined;

  if (config.JAGC_RUNNER === 'echo') {
    runExecutor = new EchoRunExecutor();
  } else {
    const piRunExecutor = new PiRunExecutor(runStore, {
      workspaceDir: config.JAGC_WORKSPACE_DIR,
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

  const app = createApp({
    runService,
    authService,
    threadControlService,
    logger: rootLogger.child({ component: 'http_server' }),
  });

  let telegramAdapter: TelegramPollingAdapter | undefined;
  if (config.JAGC_TELEGRAM_BOT_TOKEN) {
    telegramAdapter = new TelegramPollingAdapter({
      botToken: config.JAGC_TELEGRAM_BOT_TOKEN,
      runService,
      authService,
      threadControlService,
      logger: rootLogger.child({ component: 'telegram_polling' }),
    });
  }

  let closePromise: Promise<void> | null = null;
  const close = async (signal?: string) => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      mainLogger.info({ event: 'server_shutdown_started', signal: signal ?? null });
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
