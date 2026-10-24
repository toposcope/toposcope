import { describe, expect, test } from "bun:test";
import { barRects, metricStackable, stackedPeak, type SparkLine } from "./components/metric-spark";
import { formatWidgetsParam, parseWidgetsParam } from "../shared/widgets";

const lines: SparkLine[] = [
  { key: "a", color: "#1", dashed: false, vals: [2, 4] },
  { key: "b", color: "#2", dashed: false, vals: [1, null] },
];

describe("metric bars (#237)", () => {
  test("a stack's peak is the tallest bucket's sum, and its parts sit on each other", () => {
    expect(stackedPeak(lines, 2)).toBe(4);
    const rects = barRects(lines, 2, 4, true);
    expect(rects.map((r) => [r.key, r.y, r.h])).toEqual([
      ["a", 50, 50],
      ["b", 25, 25],
      ["a", 0, 100],
    ]);
  });

  test("bars side by side split each bucket's slot", () => {
    const rects = barRects(lines, 2, 4, false);
    expect(rects).toHaveLength(3);
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
    expect(rects[0]!.w).toBeCloseTo(rects[1]!.w);
  });

  test("stacking is offered only where parts add up, with a split", () => {
    expect(metricStackable({ kind: "counter" }, "host")).toBe(true);
    expect(metricStackable({ kind: "histogram", reading: "count" }, "host")).toBe(true);
    expect(metricStackable({ kind: "gauge" }, "host")).toContain("do not add up");
    expect(metricStackable({ kind: "histogram", reading: "p99" }, "host")).toContain("do not add up");
    expect(metricStackable({ kind: "counter" }, null)).toContain("needs a split");
  });

  test("the pick is saved with the panel and read back", () => {
    const raw = "a.t.0.0.12.4.level.stacked~b.t.0.4.6.4.level.stacked.m:sandbox_starts.s:host.k";
    const widgets = parseWidgetsParam(raw);
    expect(widgets[1]).toMatchObject({ metric: "sandbox_starts", metricSplit: "host", metricChart: "stacked" });
    expect(formatWidgetsParam(widgets)).toBe(raw);
    expect(parseWidgetsParam("a.t.0.0.12.4.level.stacked~b.t.0.4.6.4.level.stacked.m:x.yb")[1]).toMatchObject({ replaceY: true, metricChart: "bars" });
    // A log panel has no metric chart.
    expect(parseWidgetsParam("a.t.0.0.12.4.level.stacked.b")[0]!.metricChart).toBeUndefined();
  });
});
