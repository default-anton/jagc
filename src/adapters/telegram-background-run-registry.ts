export class TelegramBackgroundRunRegistry {
  private readonly tasks = new Set<Promise<void>>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly abortControllersByThread = new Map<string, Set<AbortController>>();
  private readonly tasksByRunId = new Map<string, Promise<void>>();

  register(runId: string, threadKey: string, start: (signal: AbortSignal) => Promise<void>): void {
    if (this.tasksByRunId.has(runId)) {
      return;
    }

    const abortController = new AbortController();
    this.trackAbortController(threadKey, abortController);

    let task: Promise<void> | null = null;
    task = start(abortController.signal).finally(() => {
      if (task) {
        this.tasks.delete(task);
        this.tasksByRunId.delete(runId);
      }

      this.untrackAbortController(threadKey, abortController);
    });

    this.tasksByRunId.set(runId, task);
    this.tasks.add(task);
  }

  abortThread(threadKey: string): void {
    const threadControllers = this.abortControllersByThread.get(threadKey);
    if (!threadControllers) {
      return;
    }

    for (const controller of threadControllers) {
      controller.abort();
    }
  }

  async abortAllAndWait(): Promise<void> {
    for (const controller of this.abortControllers) {
      controller.abort();
    }

    if (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }

    this.abortControllers.clear();
    this.abortControllersByThread.clear();
    this.tasksByRunId.clear();
    this.tasks.clear();
  }

  private trackAbortController(threadKey: string, controller: AbortController): void {
    this.abortControllers.add(controller);

    const threadControllers = this.abortControllersByThread.get(threadKey) ?? new Set<AbortController>();
    threadControllers.add(controller);
    this.abortControllersByThread.set(threadKey, threadControllers);
  }

  private untrackAbortController(threadKey: string, controller: AbortController): void {
    this.abortControllers.delete(controller);

    const threadControllers = this.abortControllersByThread.get(threadKey);
    if (!threadControllers) {
      return;
    }

    threadControllers.delete(controller);
    if (threadControllers.size === 0) {
      this.abortControllersByThread.delete(threadKey);
    }
  }
}
