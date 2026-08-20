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
});
