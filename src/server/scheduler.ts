import { DBOS, DBOSWorkflowConflictError, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import type { RunRecord } from '../shared/run-types.js';

const runQueue = new WorkflowQueue('jagc_runs', {
  concurrency: 1,
  partitionQueue: true,
});

interface RunWorkflowInput {
  runId: string;
}

type RunWorkflowHandler = (runId: string) => Promise<void>;

let activeRunWorkflowHandler: RunWorkflowHandler | null = null;

const executeRunWorkflow = DBOS.registerWorkflow(
  async ({ runId }: RunWorkflowInput): Promise<void> => {
    if (!activeRunWorkflowHandler) {
      throw new Error('run workflow handler is not configured');
    }

    await activeRunWorkflowHandler(runId);
  },
  {
    name: 'jagc.execute_run',
    maxRecoveryAttempts: 50,
  },
);

export interface RunScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(run: RunRecord): Promise<void>;
  ensureEnqueued(run: RunRecord): Promise<boolean>;
}

interface DbosRunSchedulerOptions {
  databaseUrl: string;
  executeRunById: RunWorkflowHandler;
}

export class DbosRunScheduler implements RunScheduler {
  private started = false;

  constructor(private readonly options: DbosRunSchedulerOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    activeRunWorkflowHandler = this.options.executeRunById;

    DBOS.setConfig({
      systemDatabaseUrl: this.options.databaseUrl,
      runAdminServer: false,
      listenQueues: [runQueue],
    });

    await DBOS.launch();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (DBOS.isInitialized()) {
      await DBOS.shutdown();
    }

    activeRunWorkflowHandler = null;
  }

  async enqueue(run: RunRecord): Promise<void> {
    this.assertStarted();

    try {
      await DBOS.startWorkflow(executeRunWorkflow, {
        workflowID: run.runId,
        queueName: runQueue.name,
        enqueueOptions: {
          queuePartitionKey: run.threadKey,
        },
      })({ runId: run.runId });
    } catch (error) {
      if (isWorkflowConflict(error)) {
        return;
      }

      throw error;
    }
  }

  async ensureEnqueued(run: RunRecord): Promise<boolean> {
    this.assertStarted();

    const status = await DBOS.getWorkflowStatus(run.runId);
    if (status) {
      return false;
    }

    await this.enqueue(run);
    return true;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('run scheduler is not started');
    }
  }
}

function isWorkflowConflict(error: unknown): boolean {
  return error instanceof DBOSWorkflowConflictError;
}
