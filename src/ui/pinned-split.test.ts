import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistogramChart, HistogramHover } from "./components/histogram-chart";
import { TooltipProvider } from "./components/ui/tooltip";
import { parseSearchUrl, serializeSearchUrl } from "./search-url";
import { mergeAggSplits } from "../query/agg";
import { histogramExport } from "./export-series";
import {
  defaultTimeseries,
  formatWidgetsParam,
  parseSavedLayout,
  formatSavedLayout,
  parseWidgetsParam,
  patchWidget,
  primaryTimeseries,
  seriesQueryKey,
  widgetSeriesQuery,
} from "../shared/widgets";
import type { HistogramBucket, SearchAggResult } from "./types";

const t = (m: number) => new Date(Date.UTC(2026, 9, 16, 9, m)).toISOString();
const times = [t(0), t(15), t(30)];
const buckets: HistogramBucket[] = times.map((tt) => ({ t: tt, n: 0, series: {}, by_level: {} }));

function vcpu(keys: string[]): SearchAggResult {
  return {
    expr: "agental.box.vcpu",
    source: "metric",
    buckets: [],
    stat: null,
    kind: "gauge",
    unit: "vcpu",
    metric: "agental.box.vcpu",
    split: "basis",
    splits: keys.map((key, i) => ({
      key,
      buckets: times.map((tt) => ({ t: tt, v: 16 - i * 4 })),
      stat: 16 - i * 4,
    })),
  };
}

function pinned(aggResult: SearchAggResult | null, metricSplit: string | null, replaceY = true): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(HistogramChart, {
      buckets,
      loading: false,
      live: false,
      split: "level",
      chart: "stacked",
      logScale: false,
      onSplit: () => {},
      onChart: () => {},
      onToggleScale: () => {},
      onWindow: () => {},
      spanMs: 45 * 60_000,
      interval: null,
      onInterval: () => {},
      agg: null,
      onAgg: () => {},
      metric: "agental.box.vcpu",
      onSeries: () => {},
      metricSplit,
      onMetricSplit: () => {},
      replaceY,
      onReplaceY: () => {},
      aggResult,
      numericKeys: [],
      metricNames: [],
    })),
  ).replace(/<!-- -->/g, "");
}

describe("the pinned plot split by one label (13a)", () => {
  test("Split sits on the toolbar with the picked label; each line is named at its end", () => {
    const html = pinned(vcpu(["sellable", "sold", "used"]), "basis");
    expect(html).toContain('aria-label="Split the series by"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>basis</);
    expect(html).toContain("sellable 16");
    expect(html).toContain("sold 12");
    expect(html).toContain("used 8");
    expect(html).toContain("avg · agental.box.vcpu{basis} · vcpu");
    // Named at their ends: no legend swatches as well.
    expect(html).not.toContain("border-style:dashed");
    expect((html.match(/<polyline/g) ?? []).length).toBe(3);
  });

  test("past three lines a legend names them; `other` is dashed", () => {
    const html = pinned(vcpu(["a", "b", "c", "d", "other"]), "basis");
    expect(html).not.toContain("a 16</span>");
    expect(html).toContain("border-style:dashed");
    expect(html).toContain('stroke-dasharray="3 3"');
    expect((html.match(/<polyline/g) ?? []).length).toBe(5);
  });

  test("a split with no points says the line is missing", () => {
    const html = pinned({ ...vcpu([]), splits: [] }, "basis");
    expect(html).toContain("has no points in");
    expect(html).not.toContain("<polyline");
  });

  test("no Split control by Overlay, or before the metric's labels are known", () => {
    expect(pinned(vcpu(["sellable"]), "basis", false)).not.toContain("Split the series by");
    expect(pinned(vcpu(["sellable"]), null)).not.toContain("Split the series by");
  });

  test("a metric by Replace hides the volume group-by; Overlay keeps it", () => {
    const volumeGroupBy = />Service</;
    expect(pinned(vcpu(["sellable"]), "basis")).not.toMatch(volumeGroupBy);
    expect(pinned(vcpu(["sellable"]), null, false)).toMatch(volumeGroupBy);
  });

  test("a unit on the axis gets a 48px gutter, and the rows under the plot follow it", () => {
    const withUnit = pinned(vcpu(["sellable", "sold", "used"]), "basis");
    expect(withUnit).toContain("w-12 whitespace-nowrap");
    expect(withUnit).toMatch(/vcpu<\/span>/);
    expect(withUnit).toContain("padding-left:63px");
    expect(withUnit).not.toContain("padding-left:47px");
    const noUnit = pinned({ ...vcpu(["sellable", "sold", "used"]), unit: undefined }, "basis");
    expect(noUnit).not.toContain("w-12 whitespace-nowrap");
    expect(noUnit).toContain("padding-left:47px");
  });

  test("hover reads each line's value with its unit", () => {
    const html = renderToStaticMarkup(
      createElement(HistogramHover, {
        bucket: buckets[1]!,
        rangeLabel: "09:15–09:30",
        keys: [],
        split: "level",
        left: 0,
        side: "right",
        hint: "",
        metricLines: {
          reading: "avg",
          unit: "vcpu",
          lines: [
            { key: "sellable", color: "#38bdf8", dashed: false, v: 16 },
            { key: "used", color: "#34d399", dashed: false, v: 2.6 },
          ],
        },
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("09:15–09:30 · avg");
    expect(html).toContain("16 vcpu");
    expect(html).toContain("2.6 vcpu");
  });
});

describe("the pinned plot draws a metric sent in two units as a panel does (#331, 33e)", () => {
  const group = (unit: string, sources: string[], first: string, last: string) => ({ kind: "gauge", unit, sources, first, last });
  const twoUnits = (groups: NonNullable<SearchAggResult["units_differ"]>, ms: Array<number | null>, s: Array<number | null>): SearchAggResult => ({
    expr: "http.server.duration",
    source: "metric",
    buckets: [],
    stat: null,
    kind: "gauge",
    unit: "s",
    metric: "http.server.duration",
    units_differ: groups,
    splits: [
      { key: "ms", unit: "ms", kind: "gauge", stat: 410, buckets: times.flatMap((tt, i) => (ms[i] === null ? [] : [{ t: tt, v: ms[i]! }])) },
      { key: "s", unit: "s", kind: "gauge", stat: 0.25, buckets: times.flatMap((tt, i) => (s[i] === null ? [] : [{ t: tt, v: s[i]! }])) },
    ],
  });
  const sources = twoUnits([group("ms", ["edge-1"], t(0), t(30)), group("s", ["edge-2"], t(0), t(30))], [400, 410, 420], [0.24, 0.25, 0.26]);

  test("by Replace: two lines, each on its own unit's scale, under the line that says why", () => {
    const html = pinned(sources, null);
    expect((html.match(/<polyline/g) ?? []).length).toBe(2);
    expect(html).toContain("two units: ms (edge-1), s (edge-2)");
    // Each unit's peak on the one axis, never one scale for both.
    expect(html).toContain("scales: 483 ms, 0.30 s");
    // Each line's top is drawn at the same height on its own scale: 420 of 483 ms, 0.26 of 0.299 s.
    const tops = [...html.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]!.split(" ").at(-1)!.split(",")[1]);
    expect(tops[0]).toBe(tops[1]);
  });

  test("by Overlay too, it is its lines and never 'no points'", () => {
    const html = pinned(sources, null, false);
    expect((html.match(/<polyline/g) ?? []).length).toBe(2);
    expect(html).toContain("two units: ms (edge-1), s (edge-2)");
    expect(html).not.toContain("has no points in");
  });

  test("a unit changed at one source reads as the old line ending and the new one starting", () => {
    const moved = twoUnits([group("ms", ["here"], t(0), t(15)), group("s", ["here"], t(30), t(30))], [240, 250, null], [null, null, 0.26]);
    const html = pinned(moved, null);
    expect(html).toContain(`two units: ms until ${t(30).slice(11, 16)}, s after`);
    expect((html.match(/<polyline/g) ?? []).length).toBe(2);
  });

  test("hover reads each line in its own unit", () => {
    const html = renderToStaticMarkup(
      createElement(HistogramHover, {
        bucket: buckets[1]!,
        rangeLabel: "09:15–09:30",
        keys: [],
        split: "level",
        left: 0,
        side: "right",
        hint: "",
        metricLines: {
          reading: "avg",
          unit: "s",
          lines: [
            { key: "ms", color: "#38bdf8", dashed: false, v: 410, unit: "ms" },
            { key: "s", color: "#a78bfa", dashed: false, v: 0.25, unit: "s" },
          ],
        },
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("410 ms");
    expect(html).toContain("0.25 s");
  });
});

describe("the pinned split is kept like metric= (13a)", () => {
  test("msplit rides the URL with a metric drawn by Replace", () => {
    const state = parseSearchUrl("?range=24h&metric=agental.box.vcpu&msplit=basis&y=agg&logs=0");
    expect(primaryTimeseries(state.widgets)?.metricSplit).toBe("basis");
    expect(serializeSearchUrl(state)).toContain("msplit=basis");
    expect(state.bind).toEqual({});
  });

  test("Overlay, a log series, or no metric drop it", () => {
    expect(primaryTimeseries(parseSearchUrl("?metric=m&msplit=basis").widgets)?.metricSplit).toBeNull();
    expect(primaryTimeseries(parseSearchUrl("?agg=rate&y=agg&msplit=basis").widgets)?.metricSplit).toBeNull();
    const split = [{ ...defaultTimeseries({}), metric: "m", replaceY: true, metricSplit: "basis" }];
    expect(patchWidget(split, "a", { replaceY: false })[0]?.metricSplit).toBeNull();
    // An extra panel draws its own split, Replace or not.
    const extra = { ...defaultTimeseries({}), id: "b", y: 3, metric: "m", metricSplit: "basis" };
    expect(parseWidgetsParam(formatWidgetsParam([defaultTimeseries({}), extra]))[1]?.metricSplit).toBe("basis");
  });

  test("with extra panels, the pinned token carries it", () => {
    const widgets = [
      { ...defaultTimeseries({}), metric: "agental.box.vcpu", replaceY: true, metricSplit: "service.version" },
      { ...defaultTimeseries({}), id: "b", y: 3 },
    ];
    const back = parseWidgetsParam(formatWidgetsParam(widgets))[0];
    expect(back?.metricSplit).toBe("service.version");
    expect(seriesQueryKey(widgetSeriesQuery(back!))).toContain("|s:service.version");
  });

  test("a saved search keeps the split of every panel", () => {
    const layout = {
      logs: false,
      widgets: [
        { ...defaultTimeseries({}), metric: "agental.box.vcpu", replaceY: true, metricSplit: "basis" },
        { ...defaultTimeseries({}), id: "b", y: 3, metric: "agental.box.disk", metricSplit: "basis" },
      ],
    };
    const back = parseSavedLayout(formatSavedLayout(layout));
    expect(back?.widgets.map((w) => w.metricSplit)).toEqual(["basis", "basis"]);
  });
});

describe("Live polls merge split lines value by value", () => {
  test("old bars stay, new bars land, the poll's values name the lines", () => {
    const prev = [
      { key: "sold", buckets: [{ t: t(0), v: 11 }, { t: t(15), v: 11.2 }], stat: 11 },
      { key: "gone", buckets: [{ t: t(0), v: 1 }], stat: 1 },
    ];
    const next = mergeAggSplits(prev, [
      { key: "sold", buckets: [{ t: t(15), v: 11.4 }, { t: t(30), v: 11.6 }], stat: 11.3 },
      { key: "used", buckets: [{ t: t(30), v: 2.6 }], stat: 2.6 },
    ]);
    expect(next.map((s) => s.key)).toEqual(["sold", "used"]);
    expect(next[0]?.buckets).toEqual([
      { t: t(0), v: 11 },
      { t: t(15), v: 11.4 },
      { t: t(30), v: 11.6 },
    ]);
    expect(next[0]?.stat).toBe(11.3);
    expect(next[1]?.buckets).toEqual([{ t: t(30), v: 2.6 }]);
  });
});

describe("export of a split metric", () => {
  test("a column per line, named by its value", () => {
    const file = histogramExport(buckets, vcpu(["sellable", "used"]));
    const [head, first] = file.csv.split("\n");
    expect(head).toBe("t,n,agental.box.vcpu{basis=sellable},agental.box.vcpu{basis=used}");
    expect(first).toBe(`${t(0)},0,16,12`);
  });
});
