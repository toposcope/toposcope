import { describe, expect, test } from "bun:test";
import {
  clampSearchSpan,
  formatRangeToken,
  parseRangeMs,
  parseRangeParts,
  partsFromMs,
  rangePresets,
  resolveRange,
  retentionRangeMs,
  stepRangeCount,
} from "./relative";

describe("parseRangeMs", () => {
  test("parses presets", () => {
    expect(parseRangeMs("15m")).toBe(15 * 60 * 1000);
    expect(parseRangeMs("1h")).toBe(60 * 60 * 1000);
    expect(parseRangeMs("4h")).toBe(4 * 60 * 60 * 1000);
    expect(parseRangeMs("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseRangeMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rangePresets).toEqual(["15m", "1h", "4h", "24h", "7d"]);
  });

  test("rejects junk and oversized ranges", () => {
    expect(parseRangeMs("")).toBeNull();
    expect(parseRangeMs("15")).toBeNull();
    expect(parseRangeMs("0m")).toBeNull();
    expect(parseRangeMs("366d")).toBeNull();
    expect(parseRangeMs("9y")).toBeNull();
  });

  test("parses arbitrary tokens within 365d", () => {
    expect(parseRangeMs("90m")).toBe(90 * 60 * 1000);
    expect(parseRangeMs("1d")).toBe(24 * 60 * 60 * 1000);
    expect(parseRangeMs("8d")).toBe(8 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("365d")).toBe(365 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("1w")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("2w")).toBe(14 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("52w")).toBe(52 * 7 * 24 * 60 * 60 * 1000);
    expect(parseRangeMs("53w")).toBeNull();
  });

  test("parses milliseconds and seconds without swallowing ms as m", () => {
    expect(parseRangeMs("1ms")).toBe(1);
    expect(parseRangeMs("50ms")).toBe(50);
    expect(parseRangeMs("1s")).toBe(1000);
    expect(parseRangeMs("12s")).toBe(12_000);
    expect(parseRangeMs("1m")).toBe(60_000);
  });
});

describe("resolveRange", () => {
  test("ends at now", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    expect(resolveRange("15m", now)).toEqual({
      from: "2026-08-14T11:45:00.000Z",
      to: "2026-08-14T12:00:00.000Z",
    });
  });
});

describe("parseRangeParts", () => {
  test("splits count and unit", () => {
    expect(parseRangeParts("90m")).toEqual({ count: 90, unit: "m" });
    expect(parseRangeParts("1h")).toEqual({ count: 1, unit: "h" });
    expect(parseRangeParts("366d")).toBeNull();
  });
});

describe("stepRangeCount", () => {
  test("minutes step by 5 and clamp 1–999", () => {
    expect(stepRangeCount(90, "m", 1)).toBe(95);
    expect(stepRangeCount(3, "m", -1)).toBe(1);
    expect(stepRangeCount(997, "m", 1)).toBe(999);
  });

  test("hours, days, and weeks step by 1", () => {
    expect(stepRangeCount(1, "h", 1)).toBe(2);
    expect(stepRangeCount(7, "d", -1)).toBe(6);
    expect(stepRangeCount(1, "w", 1)).toBe(2);
  });

  test("milliseconds and seconds step by 1", () => {
    expect(stepRangeCount(50, "ms", 1)).toBe(51);
    expect(stepRangeCount(1, "s", -1)).toBe(1);
  });
});

describe("partsFromMs", () => {
  test("prefers exact days then hours then minutes", () => {
    expect(partsFromMs(7 * 24 * 60 * 60 * 1000)).toEqual({ count: 7, unit: "d" });
    expect(partsFromMs(4 * 60 * 60 * 1000)).toEqual({ count: 4, unit: "h" });
    expect(partsFromMs(90 * 60 * 1000)).toEqual({ count: 90, unit: "m" });
  });

  test("uses seconds and milliseconds under a minute", () => {
    expect(partsFromMs(12_000)).toEqual({ count: 12, unit: "s" });
    expect(partsFromMs(50)).toEqual({ count: 50, unit: "ms" });
  });
});

describe("formatRangeToken", () => {
  test("joins count and unit", () => {
    expect(formatRangeToken(90, "m")).toBe("90m");
    expect(parseRangeMs(formatRangeToken(366, "d"))).toBeNull();
    expect(parseRangeMs(formatRangeToken(8, "d"))).toBe(8 * 24 * 60 * 60 * 1000);
  });
});

describe("clampSearchSpan", () => {
  test("raises from when the span exceeds 365d", () => {
    const to = "2026-08-14T12:00:00.000Z";
    const from = "2025-01-01T00:00:00.000Z";
    const clamped = clampSearchSpan(from, to);
    expect(clamped.to).toBe(to);
    expect(Date.parse(clamped.from ?? "")).toBe(
      Date.parse(to) - 365 * 24 * 60 * 60 * 1000,
    );
  });

  test("leaves a 30d window alone", () => {
    expect(
      clampSearchSpan("2026-07-15T12:00:00.000Z", "2026-08-14T12:00:00.000Z"),
    ).toEqual({
      from: "2026-07-15T12:00:00.000Z",
      to: "2026-08-14T12:00:00.000Z",
    });
  });
});

describe("retentionRangeMs", () => {
  test("clamps days the same way Settings does", () => {
    expect(retentionRangeMs(30)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(retentionRangeMs(365)).toBe(365 * 24 * 60 * 60 * 1000);
    expect(retentionRangeMs(0)).toBe(24 * 60 * 60 * 1000);
    expect(retentionRangeMs(400)).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

