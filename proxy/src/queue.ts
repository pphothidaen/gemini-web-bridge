export class RequestQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const currentTask = this.queue.shift();
    if (currentTask) {
      try {
        await currentTask();
      } finally {
        this.isProcessing = false;
        this.processNext();
      }
    }
  }
}
