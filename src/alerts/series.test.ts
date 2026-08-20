import { describe, expect, test } from "bun:test";
import { alertSeriesLabel, applyHistogramCountRefuse, seriesFromSearch } from "./series";

describe("seriesFromSearch", () => {
  test("count uses the window total", () => {
    expect(seriesFromSearch(null, 12, undefined)).toEqual({
      expr: null,
      count: 12,
      value: 12,
      refused: false,
    });
  });

  test("p99 uses the window stat", () => {
    expect(
      seriesFromSearch("p99:duration_ms", 40, {
        expr: "p99:duration_ms",
        source: "numeric",
        buckets: [{ t: "2026-08-15T00:00:00.000Z", v: 80 }],
        stat: 912,
      }),
    ).toEqual({
      expr: "p99:duration_ms",
      count: 40,
      value: 912,
      refused: false,
    });
  });

  test("refused agg does not fire from a missing stat", () => {
    expect(
      seriesFromSearch("p99:duration_ms", 40, {
        expr: "p99:duration_ms",
        source: "refused",
        reason: "p99/avg over this query exceeds the scan budget",
        buckets: [],
        stat: null,
      }),
    ).toMatchObject({
      refused: true,
      value: 0,
      count: 40,
    });
  });
});

describe("applyHistogramCountRefuse", () => {
  test("histogram refuse refuses the count; event-page refuse does not", () => {
    const ok = seriesFromSearch(null, 12, undefined);
    expect(
      applyHistogramCountRefuse(ok, {
        histogram: false,
        reason: "this query exceeds the scan budget",
      }),
    ).toEqual(ok);
    expect(
      applyHistogramCountRefuse(ok, {
        histogram: true,
        reason: "this query exceeds the scan budget",
      }),
    ).toMatchObject({
      refused: true,
      count: 12,
      value: 12,
      reason: "this query exceeds the scan budget",
    });
  });
});

describe("alertSeriesLabel", () => {
  test("names count, rate, and p99", () => {
    expect(alertSeriesLabel(null)).toBe("Count");
    expect(alertSeriesLabel("rate")).toBe("rate");
    expect(alertSeriesLabel("p99:duration_ms")).toBe("p99(duration_ms)");
  });
});
