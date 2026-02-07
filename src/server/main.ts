import { Pool } from 'pg';

import { TelegramPollingAdapter } from '../adapters/telegram-polling.js';
import { bootstrapAgentDir } from '../runtime/agent-dir-bootstrap.js';
import { PiAuthService } from '../runtime/pi-auth.js';
import { PiRunExecutor, type ThreadControlService } from '../runtime/pi-executor.js';
import { loadConfig } from '../shared/config.js';
import { createApp } from './app.js';
import { EchoRunExecutor, type RunExecutor } from './executor.js';
import { runMigrations } from './migrations.js';
import { DbosRunScheduler } from './scheduler.js';
import { RunService } from './service.js';
import { PostgresRunStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const bootstrapResult = await bootstrapAgentDir(config.JAGC_WORKSPACE_DIR);
  if (bootstrapResult.copiedAuth || bootstrapResult.copiedSettings) {
    console.info(
      JSON.stringify({
        event: 'workspace_bootstrap',
        workspace_dir: config.JAGC_WORKSPACE_DIR,
        copied_auth: bootstrapResult.copiedAuth,
        copied_settings: bootstrapResult.copiedSettings,
      }),
    );
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
  const runScheduler = new DbosRunScheduler({
    databaseUrl: config.JAGC_DATABASE_URL,
    executeRunById: async (runId) => {
      if (!runService) {
        throw new Error('run service is not initialized');
      }

      await runService.executeRunById(runId);
    },
  });

  runService = new RunService(runStore, runExecutor, runScheduler);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
