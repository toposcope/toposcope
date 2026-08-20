import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "./load-http";

describe("retryDelayMs", () => {
  test("uses Retry-After seconds", () => {
    expect(retryDelayMs(0, "1")).toBe(1000);
    expect(retryDelayMs(7, "2")).toBe(2000);
  });

  test("falls back when the header is missing or junk", () => {
    expect(retryDelayMs(0, null)).toBe(250);
    expect(retryDelayMs(1, "")).toBe(500);
    expect(retryDelayMs(0, "Wed, 21 Oct 2015 07:28:00 GMT")).toBe(250);
  });
});
