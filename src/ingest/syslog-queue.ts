import type { LogEvent } from "../shared/log-event";

export type SyslogDropReason = "queue_full" | "insert_failed";

/**
 * Rows wait here for ClickHouse. #465: at most `maxQueued` wait; a row that arrives when it is full
 * is dropped, and so is a batch whose insert fails. `onDrop` counts both.
 */
export function createSyslogInsertQueue(opts: {
  insert: (events: LogEvent[]) => Promise<number>;
  maxBatch: number;
  maxQueued: number;
  onError?: (err: unknown) => void;
  onDrop?: (reason: SyslogDropReason, n: number) => void;
}): {
  enqueue: (event: LogEvent) => boolean;
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
        try {
          await opts.insert(batch);
        } catch (err) {
          opts.onDrop?.("insert_failed", batch.length);
          opts.onError?.(err);
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    enqueue(event) {
      if (queue.length >= opts.maxQueued) {
        opts.onDrop?.("queue_full", 1);
        return false;
      }
      queue.push(event);
      if (!flushing) {
        chain = chain.then(flush, flush);
      }
      return true;
    },
    idle() {
      return chain;
    },
  };
}
