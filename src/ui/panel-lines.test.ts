import { describe, expect, test } from "bun:test";
import type { SearchAggResult } from "../query/agg";
import { defaultTimeseries, seriesQueryKey, type SeriesQuery, type WidgetDef } from "../shared/widgets";
import { panelLines, panelNote } from "./panel-lines";

// #169, frames 17b–17i: merged metrics drawn as one line each, under the names they were given.
const result = (metric: string, unit: string | undefined, v: number, extra: Partial<SearchAggResult> = {}): SearchAggResult => ({
  expr: metric,
  source: "metric",
  buckets: [{ t: "2026-10-17T07:45:00.000Z", v }],
  stat: v,
  kind: "gauge",
  ...(unit ? { unit } : {}),
  ...extra,
});

const disk = (extra: Partial<WidgetDef> = {}) =>
  defaultTimeseries({
    id: "b",
    replaceY: true,
    metric: "agental.box.disk.sellable",
    metricLabels: { box: "all" },
    lines: [
      { metric: "agental.box.disk.sold", labels: { box: "all" } },
      { metric: "agental.box.disk.used", labels: { box: "all" } },
    ],
    names: { "0": "Capacity", "1": "Promised", "2": "In use" },
    ...extra,
  });

function store(results: Record<string, SearchAggResult>) {
  return (query: SeriesQuery) => results[seriesQueryKey(query)] ?? results[query.metric ?? ""] ?? null;
}

describe("merged lines", () => {
  test("each metric is one line, under its name, on the panel's unit", () => {
    const lines = panelLines(
      disk(),
      store({
        "agental.box.disk.sellable": result("sellable", "GiBy", 310, { description: "A box's disk pool up to its limit." }),
        "agental.box.disk.sold": result("sold", "GiBy", 12.9),
        "agental.box.disk.used": result("used", "GiBy", 10.1),
      }),
    );
    expect(lines.agg?.splits?.map((s) => [s.key, s.stat])).toEqual([
      ["Capacity", 310],
      ["Promised", 12.9],
      ["In use", 10.1],
    ]);
    expect(lines.agg?.unit).toBe("GiBy");
    expect(lines.leftOff).toEqual([]);
    expect(lines.legend.map((l) => l.metric)).toEqual([
      "agental.box.disk.sellable",
      "agental.box.disk.sold",
      "agental.box.disk.used",
    ]);
  });

  test("a line with no name is called by its metric and labels", () => {
    const lines = panelLines(
      disk({ names: {} }),
      store({
        "agental.box.disk.sellable": result("sellable", "GiBy", 310),
        "agental.box.disk.sold": result("sold", "GiBy", 12.9),
        "agental.box.disk.used": result("used", "GiBy", 10.1),
      }),
    );
    expect(lines.agg?.splits?.[1]?.key).toBe("agental.box.disk.sold {box:all}");
  });

  test("a merged metric now sent in another unit is left off, and said (17e)", () => {
    const lines = panelLines(
      disk(),
      store({
        "agental.box.disk.sellable": result("sellable", "GiBy", 310),
        "agental.box.disk.sold": result("sold", "GiBy", 12.9),
        "agental.box.disk.used": result("used", "MiBy", 10_342),
      }),
    );
    expect(lines.agg?.splits?.map((s) => s.key)).toEqual(["Capacity", "Promised"]);
    expect(lines.leftOff).toEqual([{ name: "In use", metric: "agental.box.disk.used", unit: "MiB" }]);
  });

  test("two lines given one name both draw", () => {
    const lines = panelLines(
      disk({ names: { "0": "Disk", "1": "Disk", "2": "Disk" } }),
      store({
        "agental.box.disk.sellable": result("a", "GiBy", 1),
        "agental.box.disk.sold": result("b", "GiBy", 2),
        "agental.box.disk.used": result("c", "GiBy", 3),
      }),
    );
    expect(lines.agg?.splits?.map((s) => s.key)).toEqual(["Disk", "Disk (2)", "Disk (3)"]);
  });
});

describe("a split whose values are named (17i)", () => {
  test("the legend says the names; the value stays one hover away", () => {
    const panel = defaultTimeseries({
      id: "b",
      replaceY: true,
      metric: "agental.box.stranded.disk",
      metricSplit: "basis",
      names: { sold: "By promises", used: "By use" },
    });
    const lines = panelLines(
      panel,
      store({
        "agental.box.stranded.disk": result("stranded", "GiBy", 0, {
          split: "basis",
          splits: [
            { key: "sold", buckets: [], stat: 17.2 },
            { key: "used", buckets: [], stat: 19.9 },
          ],
        }),
      }),
    );
    expect(lines.agg?.splits?.map((s) => s.key)).toEqual(["By promises", "By use"]);
    expect(lines.legend.map((l) => l.labels)).toEqual(["basis:sold", "basis:used"]);
  });
});

describe("the note line", () => {
  test("the operator's note wins; a one-line panel with none shows the sender's description, marked (17f)", () => {
    const one = defaultTimeseries({ id: "b", metric: "agental.box.stranded.disk" });
    const said = { agg: null, leftOff: [], description: "Free disk nobody can be sold.", legend: [] };
    expect(panelNote(one, said)).toEqual({ text: "Free disk nobody can be sold.", sender: true });
    expect(panelNote({ ...one, note: "Should sit near 0." }, said)).toEqual({ text: "Should sit near 0.", sender: false });
    expect(panelNote(disk(), said)).toBeNull();
  });
});
