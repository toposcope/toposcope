import { describe, expect, test } from "bun:test";
import { MAX_RANGE_MS } from "../query/relative";
import { applyAbsDay, clampAbsWindow, resolveRangeApply } from "./absolute-range";
import { toLocalInput } from "./search-url";
import {
  absApplyPreview,
  absStampUtc,
  commitAbsLocal,
  formatCustomRangeLabel,
  formatSearchElapsed,
  formatSpanShort,
  rangeTriggerLabel,
  scanningRangeLabel,
} from "./time-range";

const NOW = Date.UTC(2026, 7, 14, 18, 0, 0, 0);

describe("rangeTriggerLabel", () => {
  test("prefixes relative ranges with Last", () => {
    expect(rangeTriggerLabel("1h", "2026-08-14T01:00", "2026-08-14T02:00")).toBe(
      "Last 1h",
    );
    expect(rangeTriggerLabel("90m", "2026-08-14T01:00", "2026-08-14T02:30")).toBe(
      "Last 90m",
    );
    expect(rangeTriggerLabel("1w", "2026-08-14T01:00", "2026-08-21T01:00")).toBe(
      "Last 1w",
    );
  });

  test("custom prints both UTC ends and the span", () => {
    const from = toLocalInput(new Date(Date.UTC(2026, 7, 14, 14, 0, 0, 0)));
    const to = toLocalInput(new Date(Date.UTC(2026, 7, 14, 15, 0, 0, 0)));
    expect(rangeTriggerLabel("custom", from, to, NOW)).toBe(
      "08-14 14:00 → 15:00 · 1h",
    );
  });

  test("custom keeps seconds and milliseconds when either end has them", () => {
    const from = toLocalInput(new Date(Date.UTC(2026, 7, 14, 15, 4, 5, 123)));
    const to = toLocalInput(new Date(Date.UTC(2026, 7, 14, 15, 4, 5, 135)));
    expect(rangeTriggerLabel("custom", from, to, NOW)).toBe(
      "08-14 15:04:05.123 → 15:04:05.135 · 12ms",
    );
  });

  test("custom repeats the date when the window crosses a UTC day", () => {
    const from = toLocalInput(new Date(Date.UTC(2026, 7, 14, 22, 0, 0, 0)));
    const to = toLocalInput(new Date(Date.UTC(2026, 7, 15, 2, 0, 0, 0)));
    expect(rangeTriggerLabel("custom", from, to, NOW)).toBe(
      "08-14 22:00 → 08-15 02:00 · 4h",
    );
  });
});

describe("formatCustomRangeLabel", () => {
  test("prefixes the year when an end is not this UTC year", () => {
    expect(
      formatCustomRangeLabel(
        Date.UTC(2025, 11, 31, 22, 0, 0, 0),
        Date.UTC(2026, 0, 1, 2, 0, 0, 0),
        NOW,
      ),
    ).toBe("2025-12-31 22:00 → 2026-01-01 02:00 · 4h");
  });
});

describe("formatSpanShort", () => {
  test("uses exact days and hours when they divide", () => {
    expect(formatSpanShort(7 * 24 * 60 * 60 * 1000)).toBe("7d");
    expect(formatSpanShort(90 * 60 * 1000)).toBe("2h");
    expect(formatSpanShort(15 * 60 * 1000)).toBe("15m");
  });

  test("uses seconds and milliseconds under a minute", () => {
    expect(formatSpanShort(12_000)).toBe("12s");
    expect(formatSpanShort(12)).toBe("12ms");
  });
});

describe("formatSearchElapsed", () => {
  test("one decimal second", () => {
    expect(formatSearchElapsed(1400)).toBe("1.4s");
  });
});

describe("scanningRangeLabel", () => {
  test("keeps the token for relative ranges", () => {
    expect(scanningRangeLabel("90m")).toBe("90m");
    expect(scanningRangeLabel("custom")).toBe("custom");
  });
});

describe("absStampUtc", () => {
  test("includes seconds and milliseconds in UTC", () => {
    expect(absStampUtc(Date.UTC(2026, 7, 14, 15, 4, 5, 123))).toBe(
      "2026-08-14 15:04:05.123",
    );
  });
});

describe("commitAbsLocal", () => {
  test("pins a 1ms window when From crosses To", () => {
    const next = commitAbsLocal(
      "from",
      "2026-08-14T15:04:05.200",
      "2026-08-14T15:04:05.100",
      "2026-08-14T15:04:05.150",
    );
    expect(next).toEqual({
      from: "2026-08-14T15:04:05.200",
      to: "2026-08-14T15:04:05.201",
    });
  });
});

describe("applyAbsDay", () => {
  test("keeps To when From stays earlier, then hands off to time", () => {
    const from = Date.UTC(2026, 7, 14, 14, 30, 0, 0);
    const to = Date.UTC(2026, 7, 14, 15, 30, 0, 0);
    const day = Date.UTC(2026, 7, 13, 0, 0, 0, 0);
    expect(applyAbsDay("from", day, from, to)).toEqual({
      fromMs: Date.UTC(2026, 7, 13, 14, 30, 0, 0),
      toMs: to,
      pick: "from",
    });
  });

  test("a To click before From is read as a new start", () => {
    const from = Date.UTC(2026, 7, 14, 14, 30, 0, 0);
    const to = Date.UTC(2026, 7, 14, 15, 30, 0, 0);
    const day = Date.UTC(2026, 7, 13, 0, 0, 0, 0);
    expect(applyAbsDay("to", day, from, to)).toEqual({
      fromMs: Date.UTC(2026, 7, 13, 14, 30, 0, 0),
      toMs: to,
      pick: "from",
    });
  });
});

describe("resolveRangeApply", () => {
  test("Apply writes the absolute draft when it was touched", () => {
    const from = Date.UTC(2026, 7, 14, 14, 0, 0, 0);
    const to = Date.UTC(2026, 7, 14, 15, 0, 0, 0);
    expect(resolveRangeApply(true, from, to, "1h", true)).toEqual({
      kind: "abs",
      fromMs: from,
      toMs: to,
    });
  });

  test("Apply writes Relative when Absolute was not touched", () => {
    expect(
      resolveRangeApply(false, 0, 0, "90m", true),
    ).toEqual({ kind: "rel", token: "90m" });
  });

  test("Apply stays off when the absolute draft is illegal", () => {
    expect(resolveRangeApply(true, 10, 10, "1h", true)).toBeNull();
  });
});

describe("absApplyPreview", () => {
  test("names both ends and the span", () => {
    expect(
      absApplyPreview(
        Date.UTC(2026, 7, 14, 14, 0, 0, 0),
        Date.UTC(2026, 7, 14, 15, 0, 0, 0),
      ),
    ).toBe("Applies 2026-08-14 14:00:00.000 → 15:00:00.000 · 1h");
  });
});

describe("clampAbsWindow", () => {
  test("leaves a window under 365d alone", () => {
    const from = Date.UTC(2026, 7, 1, 0, 0, 0, 0);
    const to = Date.UTC(2026, 7, 14, 0, 0, 0, 0);
    expect(clampAbsWindow(from, to, "from")).toEqual({
      fromMs: from,
      toMs: to,
    });
  });

  test("caps a From edit at 365 days", () => {
    const from = Date.UTC(2025, 0, 1, 0, 0, 0, 0);
    const to = Date.UTC(2026, 7, 14, 0, 0, 0, 0);
    expect(clampAbsWindow(from, to, "from")).toEqual({
      fromMs: from,
      toMs: from + MAX_RANGE_MS,
    });
  });
});
