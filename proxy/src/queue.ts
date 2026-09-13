interface QueueTaskOptions {
  timeoutMs?: number;
}

export class RequestQueue {
  private queue: { task: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (err: Error) => void; timeoutMs?: number }[] = [];
  private isProcessing = false;

  public enqueue<T>(task: () => Promise<T>, options?: QueueTaskOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 300_000; // 5 นาที default
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.queue.push({
        task: async () => {
          try {
            const result = await task();
            clearTimeout(timeoutHandle);
            resolve(result);
          } catch (err) {
            clearTimeout(timeoutHandle);
            reject(err as Error);
          }
        },
        resolve: () => {},
        reject: (err: Error) => {
          clearTimeout(timeoutHandle);
          reject(err);
        },
        timeoutMs
      });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const current = this.queue.shift();
    if (current) {
      try {
        await current.task();
      } finally {
        this.isProcessing = false;
        this.processNext();
      }
    }
  }
}
