import { describe, expect, test } from "bun:test";
import {
  hbarExport,
  histogramExport,
  statExport,
  widgetExportFilename,
  widgetSeriesText,
} from "./export-series";
import type { HistogramBucket } from "./types";

const buckets: HistogramBucket[] = [
  {
    t: "2026-08-15T00:00:00.000Z",
    n: 10,
    series: { error: 4, info: 6 },
    by_level: { error: 4, info: 6 },
  },
  {
    t: "2026-08-15T00:01:00.000Z",
    n: 5,
    series: { error: 5 },
    by_level: { error: 5 },
  },
];

describe("histogramExport", () => {
  test("writes volume plus series keys", () => {
    const file = histogramExport(buckets);
    expect(file.csv).toContain("t,n,error,info");
    expect(file.csv).toContain("2026-08-15T00:00:00.000Z,10,4,6");
    expect(file.csv).toContain("2026-08-15T00:01:00.000Z,5,5,0");
    const rows = JSON.parse(file.json) as Array<{ n: number; error: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.error).toBe(4);
  });

  test("adds a painted agg column", () => {
    const file = histogramExport(buckets, {
      expr: "p99:duration_ms",
      source: "numeric",
      buckets: [
        { t: "2026-08-15T00:00:00.000Z", v: 80 },
        { t: "2026-08-15T00:01:00.000Z", v: 42 },
      ],
      stat: 80,
    });
    expect(file.csv).toContain("p99:duration_ms");
    expect(file.csv).toContain(",80");
    const rows = JSON.parse(file.json) as Array<{ "p99:duration_ms": number }>;
    expect(rows[1]?.["p99:duration_ms"]).toBe(42);
  });

  test("omits a refused agg", () => {
    const file = histogramExport(buckets, {
      expr: "p99:duration_ms",
      source: "refused",
      reason: "p99/avg over this query exceeds the scan budget",
      buckets: [],
      stat: null,
    });
    expect(file.csv).not.toContain("p99:duration_ms");
  });
});

describe("statExport", () => {
  test("writes the window value", () => {
    const file = statExport({
      series: "p99(duration_ms)",
      value: 42,
      total: 40,
    });
    expect(file.csv).toBe("series,value,total\np99(duration_ms),42,40\n");
    expect(JSON.parse(file.json)).toEqual({
      series: "p99(duration_ms)",
      value: 42,
      total: 40,
    });
  });
});

describe("hbarExport", () => {
  test("writes painted rows including other", () => {
    const file = hbarExport([
      { key: "error", n: 12 },
      { key: "other", n: 3 },
    ]);
    expect(file.csv).toBe("key,n\nerror,12\nother,3\n");
    expect(JSON.parse(file.json)).toEqual([
      { key: "error", n: 12 },
      { key: "other", n: 3 },
    ]);
    expect(file.svg).toContain("<svg");
    expect(file.svg).toContain("error");
  });
});

describe("picture export", () => {
  test("histogram svg paints stacked rects from the series", () => {
    const file = histogramExport(buckets);
    expect(file.svg).toContain("<rect");
    expect(file.svg).toContain("#ef4444");
  });

  test("stat svg paints the window value", () => {
    const file = statExport({ series: "rate", value: 12, total: 40 });
    expect(file.svg).toContain("<svg");
    expect(file.svg).toContain("12");
    expect(file.svg).toContain("rate");
  });

  test("clipboard text matches the export payload", () => {
    const file = histogramExport(buckets);
    expect(widgetSeriesText(file, "csv")).toBe(file.csv);
    expect(widgetSeriesText(file, "json")).toBe(file.json);
    expect(widgetSeriesText(file, "svg")).toBe(file.svg);
    const bars = hbarExport([{ key: "error", n: 12 }]);
    expect(widgetSeriesText(bars, "csv")).toBe(bars.csv);
    const stat = statExport({ series: "rate", value: 12, total: 40 });
    expect(widgetSeriesText(stat, "json")).toBe(stat.json);
  });

  test("filenames follow toposcope-{kind}-STAMP.{ext}", () => {
    const at = new Date("2026-08-15T12:34:56.000Z");
    expect(widgetExportFilename("histogram", "csv", at)).toBe(
      "toposcope-histogram-2026-08-15T123456.csv",
    );
    expect(widgetExportFilename("stat", "png", at)).toBe(
      "toposcope-stat-2026-08-15T123456.png",
    );
    expect(widgetExportFilename("hbar", "svg", at)).toBe(
      "toposcope-hbar-2026-08-15T123456.svg",
    );
  });
});
