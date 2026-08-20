import { describe, expect, test } from "bun:test";
import type { HistogramBucket } from "./types";
import { seriesKeys } from "./histogram-series";

function bucket(series: Record<string, number>): HistogramBucket {
  const n = Object.values(series).reduce((sum, v) => sum + v, 0);
  return { t: "2026-08-14T10:00:00.000Z", n, series, by_level: {} };
}

describe("seriesKeys", () => {
  test("orders levels quietest first so error sits on top", () => {
    expect(
      seriesKeys(
        [bucket({ error: 2, debug: 1, info: 4 })],
        "level",
      ),
    ).toEqual(["debug", "info", "error"]);
  });

  test("ranks services by total and keeps other last", () => {
    expect(
      seriesKeys(
        [bucket({ other: 90, api: 10, web: 20 })],
        "service",
      ),
    ).toEqual(["web", "api", "other"]);
  });

  test("uses a single events series when split is none", () => {
    expect(seriesKeys([bucket({})], "none")).toEqual(["events"]);
  });
});
