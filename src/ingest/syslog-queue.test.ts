import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../shared/log-event";
import { createSyslogInsertQueue } from "./syslog-queue";

function event(message: string): LogEvent {
  return {
    ts: "2026-08-15T00:00:00.000Z",
    service: "api",
    host: "api-1",
    level: "info",
    message,
  };
}

describe("createSyslogInsertQueue", () => {
  test("batches up to maxBatch", async () => {
    const calls: string[][] = [];
    const queue = createSyslogInsertQueue({
      maxBatch: 2,
      maxQueued: 100,
      insert: async (events) => {
        calls.push(events.map((row) => row.message));
        return events.length;
      },
    });
    queue.enqueue(event("a"));
    queue.enqueue(event("b"));
    queue.enqueue(event("c"));
    await queue.idle();
    expect(calls).toEqual([["a", "b"], ["c"]]);
  });

  test("queues arrivals while a flush is in flight", async () => {
    const calls: number[] = [];
    let releaseFirst = (): void => {};
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sawFirst = (): void => {};
    const firstStarted = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    const queue = createSyslogInsertQueue({
      maxBatch: 10,
      maxQueued: 100,
      insert: async (events) => {
        calls.push(events.length);
        if (calls.length === 1) {
          sawFirst();
          await firstHold;
        }
        return events.length;
      },
    });
    queue.enqueue(event("a"));
    await firstStarted;
    queue.enqueue(event("b"));
    queue.enqueue(event("c"));
    releaseFirst();
    await queue.idle();
    expect(calls).toEqual([1, 2]);
  });

  // #465
  test("drops a row that arrives when maxQueued rows wait, and counts it", async () => {
    const drops: Array<[string, number]> = [];
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: string[] = [];
    const queue = createSyslogInsertQueue({
      maxBatch: 1,
      maxQueued: 2,
      insert: async (events) => {
        await hold;
        stored.push(...events.map((row) => row.message));
        return events.length;
      },
      onDrop: (reason, n) => drops.push([reason, n]),
    });
    expect(queue.enqueue(event("a"))).toBe(true);
    await Bun.sleep(0);
    expect(queue.enqueue(event("b"))).toBe(true);
    expect(queue.enqueue(event("c"))).toBe(true);
    expect(queue.enqueue(event("d"))).toBe(false);
    release();
    await queue.idle();
    expect(stored).toEqual(["a", "b", "c"]);
    expect(drops).toEqual([["queue_full", 1]]);
  });

  test("counts a failed batch as dropped and goes on with the next", async () => {
    const drops: Array<[string, number]> = [];
    const errors: unknown[] = [];
    const stored: string[] = [];
    const queue = createSyslogInsertQueue({
      maxBatch: 2,
      maxQueued: 100,
      insert: async (events) => {
        if (events[0]?.message === "a") {
          throw new Error("ClickHouse is down");
        }
        stored.push(...events.map((row) => row.message));
        return events.length;
      },
      onError: (err) => errors.push(err),
      onDrop: (reason, n) => drops.push([reason, n]),
    });
    for (const m of ["a", "b", "c"]) {
      queue.enqueue(event(m));
    }
    await queue.idle();
    expect(stored).toEqual(["c"]);
    expect(drops).toEqual([["insert_failed", 2]]);
    expect(errors).toHaveLength(1);
  });
});
