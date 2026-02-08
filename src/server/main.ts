import { Pool } from 'pg';

import { TelegramPollingAdapter } from '../adapters/telegram-polling.js';
import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { PiAuthService } from '../runtime/pi-auth.js';
import { PiRunExecutor, type ThreadControlService } from '../runtime/pi-executor.js';
import { loadConfig } from '../shared/config.js';
import { createJsonLogger, resolveLogLevel } from '../shared/logger.js';
import { createApp } from './app.js';
import { EchoRunExecutor, type RunExecutor } from './executor.js';
import { runMigrations } from './migrations.js';
import { LocalRunScheduler } from './scheduler.js';
import { RunService } from './service.js';
import { PostgresRunStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createJsonLogger({ level: config.JAGC_LOG_LEVEL });

  const bootstrapResult = await bootstrapAgentDir(config.JAGC_WORKSPACE_DIR);
  if (bootstrapResult.createdDirectory) {
    logger.info({
      event: 'workspace_bootstrap',
      workspace_dir: config.JAGC_WORKSPACE_DIR,
      created_directory: true,
    });
  }

  const pool = new Pool({
    connectionString: config.JAGC_DATABASE_URL,
  });

  await runMigrations(pool);

  const runStore = new PostgresRunStore(pool);

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
    logger,
  });

  runService = new RunService(runStore, runExecutor, runScheduler, logger);
  await runService.init();

  const authService = new PiAuthService(config.JAGC_WORKSPACE_DIR);

  const app = createApp({
    runService,
    authService,
    threadControlService,
    logger: {
      level: config.JAGC_LOG_LEVEL,
    },
  });

  let telegramAdapter: TelegramPollingAdapter | undefined;
  if (config.JAGC_TELEGRAM_BOT_TOKEN) {
    telegramAdapter = new TelegramPollingAdapter({
      botToken: config.JAGC_TELEGRAM_BOT_TOKEN,
      runService,
      authService,
      threadControlService,
      logger,
    });
  }

  const close = async () => {
    await telegramAdapter?.stop();
    await app.close();
    await runService.shutdown();
    await pool.end();
  };

  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({
    port: config.JAGC_PORT,
    host: config.JAGC_HOST,
  });

  if (telegramAdapter) {
    await telegramAdapter.start();
  }
}

const startupLogger = createJsonLogger({
  level: resolveLogLevel(process.env.JAGC_LOG_LEVEL),
});

main().catch((error) => {
  startupLogger.error({
    event: 'server_main_failed',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
