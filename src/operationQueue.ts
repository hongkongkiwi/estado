/**
 * Serializes asynchronous operations for one Durable Object instance. The
 * lock record itself remains in Durable Object storage, so a fresh instance
 * starts from the persisted lock state before accepting the next operation.
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
