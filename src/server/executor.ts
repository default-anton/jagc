import type { RunOutput, RunRecord } from '../shared/run-types.js';

export interface RunExecutor {
  execute(run: RunRecord): Promise<RunOutput>;
}

export class EchoRunExecutor implements RunExecutor {
  constructor(private readonly latencyMs: number = 50) {}

  async execute(run: RunRecord): Promise<RunOutput> {
    await sleep(this.latencyMs);

    return {
      type: 'message',
      text: run.inputText,
      delivery_mode: run.deliveryMode,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
