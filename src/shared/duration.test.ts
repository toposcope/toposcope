import { describe, expect, test } from "bun:test";
import { formatDuration } from "./duration";

// Sheet 45 (#445): one formatter in three styles; each place reads as it did before.
describe("formatDuration", () => {
  test("short: a window or a bar, whole days and hours first", () => {
    expect(formatDuration(900_000, "short")).toBe("15m");
    expect(formatDuration(86_400_000, "short")).toBe("1d");
    expect(formatDuration(5_400_000, "short")).toBe("2h");
    expect(formatDuration(250, "short")).toBe("250ms");
  });

  test("short, whole: a setting or a bar width in its largest whole unit", () => {
    expect(formatDuration(90_000, "short", { whole: true })).toBe("90s");
    expect(formatDuration(604_800_000, "short", { whole: true })).toBe("7d");
    expect(formatDuration(0, "short", { whole: true })).toBe("0");
  });

  test("short, from 1s: a Live age", () => {
    expect(formatDuration(200, "short", { least: "s" })).toBe("1s");
    expect(formatDuration(90_000, "short", { least: "s" })).toBe("2m");
  });

  test("long: open for, then a run, a mark and a cut", () => {
    expect(formatDuration(28_740_000, "long")).toBe("7h 59m");
    expect(formatDuration(273_600_000, "long")).toBe("3d 4h");
    expect(formatDuration(192_000, "long", { round: true, seconds: true })).toBe("3m 12s");
    expect(formatDuration(62 * 60_000, "long", { round: true })).toBe("1h 2m");
    expect(formatDuration(89_000, "long", { round: true })).toBe("1m");
    expect(formatDuration(89_000, "long", { round: true, seconds: true, days: "exact" })).toBe("1m 29s");
  });

  test("precise: search elapsed and a span", () => {
    expect(formatDuration(1_234, "precise")).toBe("1.2s");
    expect(formatDuration(32.44, "precise", { unit: "ms" })).toBe("32.4ms");
    expect(formatDuration(412.2, "precise", { unit: "ms" })).toBe("412ms");
  });
});
