import { describe, expect, test } from "bun:test";
import {
  InsertBackpressureError,
  isClickHouseBusy,
  retryWhenBusy,
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
