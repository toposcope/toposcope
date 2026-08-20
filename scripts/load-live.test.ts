import { describe, expect, test } from "bun:test";
import { MAX_BATCH } from "../src/ingest";
import { addIngested, liveDueCount, mapLimit } from "./load-live";

describe("addIngested", () => {
  test("does not drop increments under concurrent awaits", async () => {
    const counts = { logs: 0, metrics: 0, traces: 0 };
    await Promise.all(
      Array.from({ length: 24 }, () =>
        addIngested(counts, "logs", Promise.resolve(500)),
      ),
    );
    expect(counts.logs).toBe(12_000);
  });
});

describe("liveDueCount", () => {
  test("is zero when the rate is off", () => {
    expect(liveDueCount(80, 0)).toEqual({ n: 0, acc: 0 });
  });

  test("takes the whole remainder under the wave cap", () => {
    const due = liveDueCount(20.4, 100);
    expect(due.n).toBe(20);
    expect(due.acc).toBeCloseTo(0.4, 10);
  });

  test("caps a wave at 2s of the requested rate", () => {
    const due = liveDueCount(10_000, 1000);
    expect(due.n).toBe(2000);
    expect(due.acc).toBe(2000);
  });

  test("never schedules more than MAX_WAVE", () => {
    const due = liveDueCount(1_000_000, 100_000);
    expect(due.n).toBeLessThanOrEqual(50_000);
    expect(due.n).toBeGreaterThanOrEqual(MAX_BATCH);
  });
});

describe("mapLimit", () => {
  test("runs every index once", async () => {
    const seen: number[] = [];
    await mapLimit(10, 3, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
