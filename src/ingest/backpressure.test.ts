import { describe, expect, test } from "bun:test";
import {
  InsertBackpressureError,
  insertsInFlight,
  isClickHouseBusy,
  maxInsertsInFlight,
  maxRowsInFlight,
  retryWhenBusy,
  withInsertSlot,
} from "./backpressure";

describe("isClickHouseBusy", () => {
  test("maps ClickHouse overload errors", () => {
    expect(isClickHouseBusy(new Error("MEMORY_LIMIT_EXCEEDED"))).toBe(true);
    expect(isClickHouseBusy(new Error("TOO_MANY_SIMULTANEOUS_QUERIES"))).toBe(
      true,
    );
    expect(isClickHouseBusy(new Error("syntax error"))).toBe(false);
  });
});

describe("retryWhenBusy", () => {
  test("retries InsertBackpressureError then succeeds", async () => {
    let n = 0;
    const result = await retryWhenBusy(
      async () => {
        n += 1;
        if (n < 3) {
          throw new InsertBackpressureError();
        }
        return "ok";
      },
      { delayMs: 0 },
    );
    expect(result).toBe("ok");
    expect(n).toBe(3);
  });

  test("does not retry other errors", async () => {
    await expect(
      retryWhenBusy(async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
  });
});

/** Holds `n` inserts of `rows` rows open until the returned release is called. */
function hold(n: number, rows: number): { done: Promise<unknown[]>; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = Promise.allSettled(Array.from({ length: n }, () => withInsertSlot(() => gate, rows)));
  return { done, release };
}

async function refused(rows: number): Promise<boolean> {
  try {
    await withInsertSlot(async () => undefined, rows);
    return false;
  } catch (err) {
    return err instanceof InsertBackpressureError;
  }
}

describe("withInsertSlot", () => {
  test("lets far more than 32 small inserts wait on ClickHouse at once", async () => {
    // 50 senders of 5 lines each were refused past the 32nd; they fit now.
    const held = hold(200, 5);
    expect(insertsInFlight()).toEqual({ inserts: 200, rows: 1_000 });
    expect(await refused(5)).toBe(false);
    held.release();
    await held.done;
    expect(insertsInFlight()).toEqual({ inserts: 0, rows: 0 });
  });

  test("refuses an insert once the rows waiting would pass the limit", async () => {
    // 32 full OTLP batches is as much as waited before; a 33rd is refused, a small one is not.
    const held = hold(32, 1_000);
    expect(await refused(1_024)).toBe(true);
    expect(await refused(maxRowsInFlight - 32_000)).toBe(false);
    held.release();
    await held.done;
  });

  test("refuses past the count limit however small the inserts", async () => {
    const held = hold(maxInsertsInFlight, 1);
    expect(await refused(1)).toBe(true);
    held.release();
    await held.done;
  });

  test("runs a batch larger than the whole row limit when nothing else waits", async () => {
    expect(await refused(maxRowsInFlight * 2)).toBe(false);
    const held = hold(1, 1);
    expect(await refused(maxRowsInFlight * 2)).toBe(true);
    held.release();
    await held.done;
  });

  test("gives its places back when the insert fails", async () => {
    await expect(withInsertSlot(async () => { throw new Error("disk full"); }, 500)).rejects.toThrow("disk full");
    expect(insertsInFlight()).toEqual({ inserts: 0, rows: 0 });
  });
});
