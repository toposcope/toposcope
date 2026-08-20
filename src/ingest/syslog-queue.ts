import type { LogEvent } from "../shared/log-event";

export function createSyslogInsertQueue(opts: {
  insert: (events: LogEvent[]) => Promise<number>;
  maxBatch: number;
  onError?: (err: unknown) => void;
}): {
  enqueue: (event: LogEvent) => void;
  idle: () => Promise<void>;
} {
  const queue: LogEvent[] = [];
  let flushing = false;
  let chain = Promise.resolve();

  async function flush(): Promise<void> {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, opts.maxBatch);
        await opts.insert(batch);
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      flushing = false;
      if (queue.length > 0) {
        await flush();
      }
    }
  }

  return {
    enqueue(event) {
      queue.push(event);
      chain = chain.then(flush, flush);
    },
    idle() {
      return chain;
    },
  };
}
