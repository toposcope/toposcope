import { describe, expect, test } from "bun:test";
import { fingerprintCutWindows } from "./fingerprint-cut";
import {
  compareFoldKind,
  compareFoldMinus,
  compareFoldNote,
  compareFoldPercent,
  compareFoldSeriesText,
  compareFoldShowDelta,
  compareFoldSideFromSearch,
  compareFoldSidesText,
  formatCompareFoldPercent,
} from "./compare-fold";

const hour = 3_600_000;
const openedAt = Date.parse("2026-08-14T15:00:00.000Z");
const huntFrom = openedAt - hour;
const huntTo = openedAt;
const markTs = Date.parse("2026-08-14T14:11:00.000Z");

function pointWindows() {
  return fingerprintCutWindows({
    markTs,
    markEndTs: null,
    kind: "deploy",
    huntFrom,
    huntTo,
    openedAt,
  });
}

describe("compareFoldPercent", () => {
  test("percent is (after − before) / before when before exists", () => {
    expect(compareFoldPercent(1970, 2210)).toBeCloseTo(12.1827, 3);
    expect(formatCompareFoldPercent(12.1827)).toBe("+12%");
  });

  test("first-seen drops the percent — a percent needs a before", () => {
    expect(compareFoldPercent(0, 418)).toBeNull();
    expect(compareFoldPercent(null, 418)).toBeNull();
  });

  test("stopped keeps −100% when after is 0 and before exists", () => {
    expect(compareFoldPercent(80, 0)).toBe(-100);
    expect(formatCompareFoldPercent(-100)).toBe(`${compareFoldMinus}100%`);
  });

  test("rounds under 9.5 to one decimal and under 0.95 to <1", () => {
    expect(formatCompareFoldPercent(1.24)).toBe("+1.2%");
    expect(formatCompareFoldPercent(-0.4)).toBe(`${compareFoldMinus}<1%`);
  });
});

describe("compareFoldNote", () => {
  const formatDuration = () => "49m";
  const side = (empty: boolean): ReturnType<typeof compareFoldSideFromSearch> => ({
    v: empty ? 0 : 10,
    n: empty ? 0 : 10,
    empty,
    refused: false,
  });

  test("dead window: nothing after to read", () => {
    const windows = fingerprintCutWindows({
      markTs: huntTo + 60_000,
      markEndTs: null,
      kind: "flag",
      huntFrom,
      huntTo,
      openedAt,
    });
    expect(
      compareFoldNote({
        windows,
        kind: "count",
        before: side(true),
        after: side(true),
        formatDuration,
      }),
    ).toBe("the window ends before this mark — nothing after to read");
  });

  test("empty hunt is — on both sides, not a percent", () => {
    expect(
      compareFoldNote({
        windows: pointWindows(),
        kind: "count",
        before: side(true),
        after: side(true),
        formatDuration,
      }),
    ).toBe("no events on either side — nothing to number");
    expect(
      compareFoldShowDelta(pointWindows(), "count", side(true), side(true)),
    ).toBe(false);
  });

  test("first seen names the missing before", () => {
    expect(
      compareFoldNote({
        windows: pointWindows(),
        kind: "count",
        before: side(true),
        after: side(false),
        formatDuration,
      }),
    ).toBe("new since this mark — a percent needs a before");
  });

  test("stopped is quiet after this mark", () => {
    expect(
      compareFoldNote({
        windows: pointWindows(),
        kind: "count",
        before: side(false),
        after: side(true),
        formatDuration,
      }),
    ).toBe("quiet after this mark");
  });
});

describe("compareFoldSeriesText", () => {
  test("Count, Rate, numeric agg, metric, and a single e1 in the bar", () => {
    expect(compareFoldSeriesText({ e1: [], agg: null, metric: null })).toEqual({
      text: "Count",
      overlay: false,
    });
    expect(
      compareFoldSeriesText({ e1: [], agg: "rate", metric: null }),
    ).toEqual({ text: "Rate", overlay: true });
    expect(
      compareFoldSeriesText({
        e1: [],
        agg: "p99:duration_ms",
        metric: null,
      }),
    ).toEqual({ text: "p99(duration_ms)", overlay: true });
    expect(
      compareFoldSeriesText({ e1: [], agg: null, metric: "cpu_seconds" }),
    ).toEqual({ text: "cpu_seconds", overlay: true });
    expect(
      compareFoldSeriesText({
        e1: ["b41f0c88a2e6d3f7"],
        agg: null,
        metric: null,
      }),
    ).toEqual({ text: "e1:b41f0c88a2e6d3f7 · count", overlay: false });
  });
});

describe("compareFoldKind / side", () => {
  test("count uses total; rate uses window stat; empty numeric is not a number", () => {
    expect(compareFoldKind(null, null)).toBe("count");
    expect(compareFoldKind("rate", null)).toBe("rate");
    expect(compareFoldKind("p99:duration_ms", null)).toBe("numeric");
    expect(compareFoldKind(null, "cpu_seconds")).toBe("metric");
    expect(
      compareFoldSideFromSearch({ total: 1970 }, "count"),
    ).toEqual({ v: 1970, n: 1970, empty: false, refused: false });
    expect(
      compareFoldSideFromSearch(
        { total: 80, agg: { stat: 0.027, source: "rate" } },
        "rate",
      ).v,
    ).toBe(0.027);
    expect(
      compareFoldSideFromSearch({ total: 0, agg: { stat: null, source: "numeric" } }, "numeric")
        .empty,
    ).toBe(true);
  });
});

describe("compareFoldSidesText", () => {
  test("equal window, band, and Live freeze stamp", () => {
    const w = pointWindows();
    expect(
      compareFoldSidesText({
        windows: w,
        frozen: false,
        frozenStamp: "15:00:00",
        formatDuration: () => "49m",
      }),
    ).toBe("equal 49m");
    const band = fingerprintCutWindows({
      markTs: Date.parse("2026-08-14T03:10:00.000Z"),
      markEndTs: Date.parse("2026-08-14T04:12:00.000Z"),
      kind: "incident",
      huntFrom: Date.parse("2026-08-14T00:00:00.000Z"),
      huntTo: openedAt,
      openedAt,
    });
    expect(
      compareFoldSidesText({
        windows: band,
        frozen: false,
        frozenStamp: "",
        formatDuration: () => "1h 2m",
      }),
    ).toBe("the band · 1h 2m, mirrored");
    expect(
      compareFoldSidesText({
        windows: w,
        frozen: true,
        frozenStamp: "15:00:00",
        formatDuration: () => "49m",
      }),
    ).toBe("equal 49m · fixed 15:00:00");
  });
});
