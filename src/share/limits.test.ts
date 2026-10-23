import { describe, expect, test } from "bun:test";
import { defaultShareLimits, parseShareLimits, windowWithin, type ShareLimits } from "./limits";

const now = Date.parse("2026-10-23T12:00:00Z");
const limits: ShareLimits = { min_step: "1m", max_range: "7d", max_lookback: "30d", reads_per_minute: 120 };
const iso = (ms: number) => new Date(ms).toISOString();
const day = 86_400_000;

describe("share limits", () => {
  test("a field left out takes its default, or what the share had", () => {
    expect(parseShareLimits(undefined)).toEqual(defaultShareLimits);
    expect(parseShareLimits({ max_range: "30d" })).toEqual({ ...defaultShareLimits, max_range: "30d" });
    const had = { ...defaultShareLimits, reads_per_minute: 300 };
    expect(parseShareLimits({ min_step: "5m" }, had)).toEqual({ ...had, min_step: "5m" });
  });

  test("refuses limits it cannot hold", () => {
    expect(parseShareLimits({ min_step: "2m" })).toHaveProperty("error");
    expect(parseShareLimits({ max_range: "400d" })).toHaveProperty("error");
    expect(parseShareLimits({ max_lookback: "800d" })).toHaveProperty("error");
    expect(parseShareLimits({ max_lookback: "400d" })).toMatchObject({ max_lookback: "400d" });
    expect(parseShareLimits({ reads_per_minute: 0 })).toHaveProperty("error");
    expect(parseShareLimits({ min_step: "1d", max_range: "12h" })).toEqual({
      error: "limits.min_step is wider than limits.max_range",
    });
  });
});

describe("a read's window inside the limits", () => {
  test("Auto snaps up to the finest bar", () => {
    // 1h on Auto is 1m bars; 15m would be 10s, snapped up to 1m.
    expect(windowWithin(limits, { range: "15m" }, now)).toEqual({ from: iso(now - 15 * 60_000), to: iso(now), step: "1m" });
    expect(windowWithin(limits, { range: "24h" }, now)).toEqual({ from: iso(now - day), to: iso(now) });
  });

  test("an explicit finer step is refused, not clamped", () => {
    expect(windowWithin(limits, { range: "1h", step: "10s" }, now)).toEqual({
      error: "this share's finest bar is 1m; step=10s is finer",
    });
    expect(windowWithin(limits, { range: "1h", step: "5m" }, now)).toMatchObject({ step: "5m" });
  });

  test("the longest window and the oldest reach", () => {
    expect(windowWithin(limits, { range: "30d" }, now)).toEqual({ error: "this share's longest window is 7d" });
    // A week at a time cannot walk back past 30 days.
    expect(windowWithin(limits, { from: iso(now - 40 * day), to: iso(now - 35 * day) }, now)).toEqual({
      error: "this share reaches back 30d",
    });
    expect(windowWithin(limits, { from: iso(now - 29 * day), to: iso(now - 28 * day) }, now)).not.toHaveProperty("error");
  });

  test("a read names a window", () => {
    expect(windowWithin(limits, {}, now)).toHaveProperty("error");
  });
});
