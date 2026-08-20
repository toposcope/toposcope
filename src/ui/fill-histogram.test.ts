import { describe, expect, test } from "bun:test";
import {
  fillHistogram,
  histogramAxisLabels,
  histogramAxisTick,
  rangeDurationMs,
  resolveHistogramStepMs,
  bucketIndexAt,
  abbrevCount,
  formatSeriesTotal,
  histogramYTicks,
  scaleCount,
  stackedSegmentPlotFrac,
} from "./fill-histogram";

describe("fillHistogram", () => {
  test("inserts zero buckets for empty minutes", () => {
    const filled = fillHistogram(
      "2026-08-14T10:00:00.000Z",
      "2026-08-14T10:03:00.000Z",
      [{ t: "2026-08-14T10:01:00.000Z", n: 4, series: { error: 4 }, by_level: { error: 4 } }],
      60_000,
    );
    expect(filled.map((b) => [b.t, b.n])).toEqual([
      ["2026-08-14T10:00:00.000Z", 0],
      ["2026-08-14T10:01:00.000Z", 4],
      ["2026-08-14T10:02:00.000Z", 0],
      ["2026-08-14T10:03:00.000Z", 0],
    ]);
  });

  test("keeps per-level counts and defaults empty minutes to none", () => {
    const filled = fillHistogram(
      "2026-08-14T10:00:00.000Z",
      "2026-08-14T10:01:00.000Z",
      [{ t: "2026-08-14T10:01:00.000Z", n: 3, series: { warn: 1, error: 2 }, by_level: { warn: 1, error: 2 } }],
      60_000,
    );
    expect(filled[0]?.by_level).toEqual({});
    expect(filled[1]?.by_level).toEqual({ warn: 1, error: 2 });
  });

  test("uses 15-minute steps for a 25h window", () => {
    const filled = fillHistogram(
      "2026-08-13T00:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      [{ t: "2026-08-13T00:15:00.000Z", n: 9, series: { info: 9 }, by_level: { info: 9 } }],
    );
    expect(filled).toHaveLength(101);
    expect(filled[0]?.t).toBe("2026-08-13T00:00:00.000Z");
    expect(filled[1]).toEqual({
      t: "2026-08-13T00:15:00.000Z",
      n: 9,
      series: { info: 9 },
      by_level: { info: 9 },
    });
    expect(filled[2]?.n).toBe(0);
  });

  test("fills 5-minute steps when the interval is passed in", () => {
    const filled = fillHistogram(
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:20:00.000Z",
      [{ t: "2026-08-14T00:10:00.000Z", n: 2, series: { info: 2 }, by_level: { info: 2 } }],
      300_000,
    );
    expect(filled.map((b) => [b.t, b.n])).toEqual([
      ["2026-08-14T00:00:00.000Z", 0],
      ["2026-08-14T00:05:00.000Z", 0],
      ["2026-08-14T00:10:00.000Z", 2],
      ["2026-08-14T00:15:00.000Z", 0],
      ["2026-08-14T00:20:00.000Z", 0],
    ]);
  });
});

describe("histogramAxisLabels", () => {
  const FROM = Date.parse("2026-08-14T14:00:00.000Z");
  const HOUR = 60 * 60_000;
  const now = Date.parse("2026-08-14T18:00:00.000Z");

  test("spreads five HH:MM ticks across the window", () => {
    expect(histogramAxisLabels(FROM, HOUR, false, now)).toEqual([
      "14:00",
      "14:15",
      "14:30",
      "14:45",
      "15:00",
    ]);
  });

  test("labels the last tick now when live", () => {
    expect(histogramAxisLabels(FROM, HOUR, true, now).at(-1)).toBe("now");
  });

  test("adds month-day on a day-or-longer window", () => {
    expect(histogramAxisLabels(FROM, 24 * HOUR, false, now)).toEqual([
      "08-14 14:00",
      "08-14 20:00",
      "08-15 02:00",
      "08-15 08:00",
      "08-15 14:00",
    ]);
  });

  test("dates the first tick when the window is not today", () => {
    const yesterday = Date.parse("2026-08-13T14:00:00.000Z");
    expect(histogramAxisLabels(yesterday, HOUR, false, now)).toEqual([
      "08-13 14:00",
      "14:15",
      "14:30",
      "14:45",
      "15:00",
    ]);
  });

  test("dates the midnight tick when the window crosses a day", () => {
    const from = Date.parse("2026-08-14T22:00:00.000Z");
    expect(histogramAxisLabels(from, 4 * HOUR, false, now)).toEqual([
      "08-14 22:00",
      "23:00",
      "08-15 00:00",
      "01:00",
      "02:00",
    ]);
  });

  test("uses seconds under 1m and milliseconds under 1s", () => {
    expect(histogramAxisLabels(FROM, 30_000, false, now)).toEqual([
      "14:00:00",
      "14:00:07",
      "14:00:15",
      "14:00:22",
      "14:00:30",
    ]);
    expect(histogramAxisLabels(FROM, 500, false, now)).toEqual([
      "14:00:00.000",
      "14:00:00.125",
      "14:00:00.250",
      "14:00:00.375",
      "14:00:00.500",
    ]);
    expect(histogramAxisLabels(FROM, 1_000, false, now)).toEqual([
      "14:00:00.000",
      "14:00:00.250",
      "14:00:00.500",
      "14:00:00.750",
      "14:00:01.000",
    ]);
  });

  test("uses milliseconds when the bar is under 1s even if the window is not", () => {
    expect(histogramAxisTick(FROM + 12, 2_000, { intervalMs: 10 })).toBe(
      "14:00:00.012",
    );
    expect(histogramAxisLabels(FROM, 2_000, false, now, 5, 10)).toEqual([
      "14:00:00.000",
      "14:00:00.500",
      "14:00:01.000",
      "14:00:01.500",
      "14:00:02.000",
    ]);
  });
});

describe("resolveHistogramStepMs", () => {
  test("reads the gap between bars and falls back to the displayed grain", () => {
    expect(
      resolveHistogramStepMs(
        [
          { t: "2026-08-14T14:00:00.000Z", n: 1, series: {}, by_level: {} },
          { t: "2026-08-14T14:00:00.010Z", n: 1, series: {}, by_level: {} },
        ],
        60_000,
      ),
    ).toBe(10);
    expect(
      resolveHistogramStepMs(
        [{ t: "2026-08-14T14:00:00.000Z", n: 1, series: {}, by_level: {} }],
        1,
      ),
    ).toBe(1);
  });
});

describe("bucketIndexAt", () => {
  test("maps the left edge, middle, and right edge of a 24h plot", () => {
    const n = 1441;
    const width = 1100;
    expect(bucketIndexAt(0, width, n)).toBe(0);
    expect(bucketIndexAt(width / 2, width, n)).toBe(Math.floor(n / 2));
    expect(bucketIndexAt(width - 0.01, width, n)).toBe(n - 1);
  });

  test("clamps outside the plot", () => {
    expect(bucketIndexAt(-8, 800, 60)).toBe(0);
    expect(bucketIndexAt(900, 800, 60)).toBe(59);
  });
});
describe("rangeDurationMs", () => {
  test("falls back to one hour when invalid", () => {
    expect(rangeDurationMs("", "")).toBe(60 * 60 * 1000);
  });
});

describe("abbrevCount", () => {
  test("uses k and M suffixes", () => {
    expect(abbrevCount(0)).toBe("0");
    expect(abbrevCount(999)).toBe("999");
    expect(abbrevCount(1200)).toBe("1.2k");
    expect(abbrevCount(15000)).toBe("15k");
    expect(abbrevCount(1_200_000)).toBe("1.2M");
  });
});

describe("formatSeriesTotal", () => {
  test("keeps exact counts under 10k", () => {
    expect(formatSeriesTotal(2184)).toBe("2,184");
    expect(formatSeriesTotal(9999)).toBe("9,999");
    expect(formatSeriesTotal(10_000)).toBe("10k");
  });
});

describe("histogramYTicks", () => {
  test("spaces four linear ticks from peak to zero", () => {
    expect(histogramYTicks(100, false)).toEqual([100, 66, 33, 0]);
  });

  test("spaces four log ticks from peak to zero", () => {
    const ticks = histogramYTicks(1000, true);
    expect(ticks[0]).toBe(1000);
    expect(ticks[3]).toBe(0);
    expect(ticks[1]).toBeGreaterThan(ticks[2] ?? 0);
    expect(ticks[2]).toBeGreaterThan(0);
  });
});

describe("scaleCount", () => {
  test("is linear or log10 against the peak", () => {
    expect(scaleCount(50, 100, false)).toBe(0.5);
    expect(scaleCount(0, 100, false)).toBe(0);
    expect(scaleCount(9, 99, true)).toBeCloseTo(Math.log10(10) / Math.log10(100));
  });
});

describe("stackedSegmentPlotFrac", () => {
  test("slices a linear column by share", () => {
    expect(stackedSegmentPlotFrac(25, 100, 100, false)).toBe(0.25);
    expect(stackedSegmentPlotFrac(0, 100, 100, false)).toBe(0);
  });

  test("log is the scaled total times share, not a sum of logs", () => {
    const peak = 1000;
    const total = 100;
    const col = scaleCount(total, peak, true);
    const a = stackedSegmentPlotFrac(80, total, peak, true);
    const b = stackedSegmentPlotFrac(20, total, peak, true);
    expect(a + b).toBeCloseTo(col);
    expect(a + b).toBeLessThan(
      scaleCount(80, peak, true) + scaleCount(20, peak, true),
    );
  });
});
