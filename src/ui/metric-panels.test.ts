import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricSpark, sparkLines, spreadLabels } from "./components/metric-spark";
import { printUnit, withUnit } from "./metric-unit";
import {
  defaultTimeseries,
  formatWidgetsParam,
  parseWidgetsParam,
  seriesQueryKey,
  showsNoLogRows,
  widgetSeriesQuery,
} from "../shared/widgets";
import type { SearchAggResult } from "./types";

const t = (m: number) => new Date(Date.UTC(2026, 9, 16, 9, m)).toISOString();
const times = [t(0), t(15), t(30)];

describe("a metric panel split by one label (#104)", () => {
  test("the split rides the panel's token and its query", () => {
    const panel = { ...defaultTimeseries({}), id: "b", y: 3, metric: "agental.box.disk", metricLabels: { box: "host-03" }, metricSplit: "basis" };
    const [, back] = parseWidgetsParam(formatWidgetsParam([defaultTimeseries({}), panel]));
    expect(back?.metric).toBe("agental.box.disk");
    expect(back?.metricLabels).toEqual({ box: "host-03" });
    expect(back?.metricSplit).toBe("basis");
    expect(seriesQueryKey(widgetSeriesQuery(back!))).toContain("|s:basis");
    // A dotted label key survives the `.`-separated token.
    const dotted = { ...panel, metricSplit: "service.version" };
    const token = formatWidgetsParam([defaultTimeseries({}), dotted]);
    expect(token).toContain("s:service%2Eversion");
    expect(parseWidgetsParam(token)[1]?.metricSplit).toBe("service.version");
  });

  test("a split on a log series is dropped", () => {
    const [, back] = parseWidgetsParam(formatWidgetsParam([defaultTimeseries({}), { ...defaultTimeseries({}), id: "b", y: 3, agg: "rate", metricSplit: "basis" }]));
    expect(back?.metricSplit).toBeNull();
  });

  test("one line per value; `other` is dashed grey; the sixth colour is not grey", () => {
    const result: SearchAggResult = {
      expr: "x", source: "metric", buckets: [], stat: null, split: "plan",
      splits: ["a", "b", "c", "d", "e", "f", "other"].map((key, i) => ({ key, buckets: [{ t: times[0]!, v: i }], stat: i })),
    };
    const lines = sparkLines(times, result);
    expect(lines.map((l) => l.key)).toEqual(["a", "b", "c", "d", "e", "f", "other"]);
    expect(lines.at(-1)).toMatchObject({ color: "#94a3b8", dashed: true });
    expect(lines[5]!.color).not.toBe("#94a3b8");
  });

  test("end labels that would collide are pushed apart", () => {
    expect(spreadLabels([10, 12, 80], 13, 100)).toEqual([10, 23, 80]);
    expect(spreadLabels([95, 96], 13, 100)).toEqual([87, 100]);
  });

  test("three lines are named at their ends, with the unit on the axis and in the hover", () => {
    const result: SearchAggResult = {
      expr: "avg(agental.box.memory)", source: "metric", buckets: [], stat: null, kind: "gauge", unit: "GiBy", split: "basis",
      splits: [
        { key: "sellable", buckets: times.map((tt) => ({ t: tt, v: 83.2 })), stat: 83.2 },
        { key: "sold", buckets: times.map((tt) => ({ t: tt, v: 63 })), stat: 63 },
        { key: "used", buckets: times.map((tt) => ({ t: tt, v: 35.2 })), stat: 35.2 },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(MetricSpark, { times, result, readingWord: "avg", kindWord: "gauge", name: "agental.box.memory", window: "24h", live: false }),
    ).replace(/<!-- -->/g, "");
    // The axis reads the peak with room above the highest line, as 13a's 96 GiBy over 83.2.
    expect(html).toContain("95.7 GiBy");
    expect(html).toContain("sellable 83.2");
    expect(html).toContain("used 35.2");
    expect(html).toContain("avg · gauge");
  });

  test("a single gauge says what it reads now; no points says the line is missing", () => {
    const one: SearchAggResult = { expr: "x", source: "metric", buckets: times.map((tt, i) => ({ t: tt, v: 40 + i })), stat: 41, kind: "gauge", unit: "GiBy" };
    const html = renderToStaticMarkup(createElement(MetricSpark, { times, result: one, readingWord: "avg", kindWord: "gauge", name: "m", window: "1h", live: false })).replace(/<!-- -->/g, "");
    expect(html).toContain("avg · gauge · now 42 GiBy");
    const none: SearchAggResult = { expr: "x", source: "metric", buckets: [], stat: null, kind: "gauge", split: "basis", splits: [] };
    const empty = renderToStaticMarkup(createElement(MetricSpark, { times, result: none, readingWord: "avg", kindWord: "gauge", name: "agental.box.disk", window: "24h", live: false })).replace(/<!-- -->/g, "");
    expect(empty).toContain("No points for agental.box.disk in this window (last 24h). The line is missing, not zero.");
    expect(empty).toContain("avg · gauge · no points");
  });
});

describe("units as sent (#104)", () => {
  test("no braces, nothing for 1, no conversion", () => {
    expect(printUnit("{request}")).toBe("request");
    expect(printUnit("1")).toBe("");
    expect(printUnit(undefined)).toBe("");
    expect(withUnit("28.8G", "By")).toBe("28.8G By");
    expect(withUnit("4", null)).toBe("4");
  });
});

describe("no sidebar count for a search kept for its panels (#104)", () => {
  test("table off and a metric drawn by Replace on the pinned plot", () => {
    const pinned = { ...defaultTimeseries({}), metric: "agental.box.vcpu", replaceY: true };
    expect(showsNoLogRows({ logs: false, widgets: [pinned] })).toBe(true);
    expect(showsNoLogRows({ logs: true, widgets: [pinned] })).toBe(false);
    expect(showsNoLogRows({ logs: false, widgets: [{ ...pinned, replaceY: false }] })).toBe(false);
    expect(showsNoLogRows(null)).toBe(false);
  });
});
