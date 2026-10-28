import { describe, expect, test } from "bun:test";
import type { HeldSource } from "../shared/held";
import type { SearchAggResult } from "../query/agg";
import { metricPanelHeld } from "./held-context";
import { heldView, metricAdds } from "./held-view";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeMark } from "../shared/change-mark";
import { unitChangeMark, unitChanges, unitsDifferWords } from "./metric-unit";
import { MetricSpark, sparkLines, unitAxes } from "./components/metric-spark";
import { metricStat } from "./components/stat-widget";

// #331, frame 33e: metric panels across sources.
const now = Date.parse("2026-10-27T13:26:00Z");
const at = (t: string) => Date.parse(`2026-10-27T${t}Z`);
const hour = { from: at("12:26:00"), to: now };
const src = (over: Partial<HeldSource> & { name: string }): HeldSource => ({ filters: [], state: { kind: "caught-up" }, hole: null, ...over });
const sources = [
  src({ name: "edge-1" }),
  src({ name: "edge-2", state: { kind: "behind", readTo: at("13:12:00") } }),
];
const held = heldView({ sources, now, live: false, window: hour, q: "", counts: new Map(), total: 0 });

const result = (over: Partial<SearchAggResult>): SearchAggResult => ({ expr: "m", source: "metric", buckets: [], stat: 1, ...over });

describe("a source short inside a metric panel's window (#331)", () => {
  test("a sum or a count is a floor, the pill naming the source", () => {
    const tells = metricPanelHeld(held, result({ kind: "counter" }), {})!;
    expect(tells.floor).toBe(true);
    expect(tells.pill).toBe("edge-2 14m behind");
    expect(tells.hatches).toEqual([{ source: "edge-2", kind: "behind", from: at("13:12:00"), to: now, label: "edge-2 · not here yet" }]);
    expect(metricPanelHeld(held, result({ kind: "histogram", reading: "count" }), {})!.floor).toBe(true);
  });

  test("an average or a percentile is named partial, never a floor", () => {
    const p99 = metricPanelHeld(held, result({ kind: "histogram", reading: "p99" }), {})!;
    expect(p99.floor).toBe(false);
    expect(p99.pill).toBe("edge-2 14m behind · p99 is partial");
    expect(metricPanelHeld(held, result({ kind: "gauge" }), {})!.pill).toBe("edge-2 14m behind · average is partial");
    expect(metricAdds({ kind: "histogram", reading: "avg" })).toBe(false);
  });

  test("nothing said when every source is caught up, or the panel keeps to another source", () => {
    const caught = heldView({ sources: [src({ name: "edge-1" })], now, live: false, window: hour, q: "", counts: new Map(), total: 0 });
    expect(metricPanelHeld(caught, result({ kind: "counter" }), {})).toBeNull();
    expect(metricPanelHeld(held, result({ kind: "counter" }), { toposcope: "edge-1" })).toBeNull();
    expect(metricPanelHeld(null, result({ kind: "counter" }), {})).toBeNull();
    expect(metricPanelHeld(held, result({ source: "refused" }), {})).toBeNull();
  });
});

const ms = { kind: "gauge", unit: "ms", sources: ["edge-1"], first: "2026-10-27T12:30:00.000Z", last: "2026-10-27T13:20:00.000Z" };
const s = { kind: "gauge", unit: "s", sources: ["here"], first: "2026-10-27T12:31:00.000Z", last: "2026-10-27T13:21:00.000Z" };

describe("a panel whose points came in two units (#331)", () => {
  test("one line says which units, and from where", () => {
    expect(unitsDifferWords([ms, s])).toBe("two units: ms (edge-1), s (here)");
    expect(unitsDifferWords([ms])).toBeNull();
    expect(unitsDifferWords(undefined)).toBeNull();
  });

  test("a unit changed at one source reads as one ending and the other starting", () => {
    const before = { ...ms, sources: ["here"], last: "2026-10-27T12:57:00.000Z" };
    const after = { ...s, first: "2026-10-27T12:58:00.000Z" };
    expect(unitsDifferWords([before, after])).toBe("two units: ms until 12:58, s after");
  });

  test("kinds that differ are said as kinds", () => {
    expect(unitsDifferWords([{ ...ms, kind: "counter", unit: "" }, { ...s, unit: "" }])).toBe("two kinds: counter (edge-1), gauge (here)");
  });

  const split = result({
    unit: "s",
    kind: "gauge",
    stat: null,
    units_differ: [ms, s],
    splits: [
      { key: "ms", unit: "ms", kind: "gauge", buckets: [{ t: "2026-10-27T13:00:00.000Z", v: 410 }], stat: 410 },
      { key: "s", unit: "s", kind: "gauge", buckets: [{ t: "2026-10-27T13:00:00.000Z", v: 0.25 }], stat: 0.25 },
    ],
  });

  test("drawn as two lines in one plot, each on its own unit's scale, never summed", () => {
    const times = ["2026-10-27T13:00:00.000Z"];
    const lines = sparkLines(times, split);
    expect(lines.map((l) => [l.key, l.unit, l.vals])).toEqual([
      ["ms", "ms", [410]],
      ["s", "s", [0.25]],
    ]);
    const axes = unitAxes(lines)!;
    expect(axes.map((a) => [a.unit, a.peak, a.color])).toEqual([
      ["ms", 410 * 1.15, lines[0]!.color],
      ["s", 0.25 * 1.15, lines[1]!.color],
    ]);
    expect(unitAxes(sparkLines(times, result({ splits: [{ key: "a", buckets: [], stat: 1 }, { key: "b", buckets: [], stat: 2 }] })))).toBeNull();
    const html = renderToStaticMarkup(
      createElement(MetricSpark, { times, result: split, readingWord: "avg", kindWord: "gauge", name: "http.server.duration", window: "1h", live: false }),
    ).replace(/<!-- -->/g, "");
    // One plot: one svg holding both lines, and each unit's peak on the one axis.
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html.match(/<polyline/g)).toHaveLength(2);
    expect(html).toContain("scales: 471 ms, 0.29 s");
  });

  const before = { ...ms, sources: ["here"], last: "2026-10-27T12:57:00.000Z" };
  const after = { ...s, first: "2026-10-27T12:58:00.000Z" };
  const deploy = (over: Partial<ChangeMark>): ChangeMark => ({
    id: "d1",
    ts: "2026-10-27T12:57:40.000Z",
    end_ts: null,
    kind: "deploy",
    service: "api",
    title: "api v2.0",
    attrs: {},
    ...over,
  });

  test("a unit changed by a deploy names the deploy, and draws it where the old line ends", () => {
    expect(unitChanges([before, after])).toEqual([{ from: before.last, to: after.first }]);
    expect(unitChanges([ms, s])).toBeNull();
    expect(unitChangeMark({ from: before.last, to: after.first }, [deploy({})])?.title).toBe("api v2.0");
    expect(unitChangeMark({ from: before.last, to: after.first }, [deploy({ kind: "note" })])).toBeNull();
    expect(unitChangeMark({ from: before.last, to: after.first }, [deploy({ ts: "2026-10-27T12:40:00.000Z" })])).toBeNull();
    expect(unitsDifferWords([before, after], [deploy({})])).toBe("two units: ms until ▲ api v2.0, s after");
    expect(unitsDifferWords([before, after], [])).toBe("two units: ms until 12:58, s after");

    const times = ["2026-10-27T12:56:00.000Z", "2026-10-27T12:57:00.000Z", "2026-10-27T12:58:00.000Z", "2026-10-27T12:59:00.000Z"];
    const moved = result({
      unit: "s",
      kind: "gauge",
      stat: null,
      units_differ: [before, after],
      splits: [
        { key: "ms", unit: "ms", kind: "gauge", buckets: [{ t: times[0]!, v: 240 }, { t: times[1]!, v: 250 }], stat: 245 },
        { key: "s", unit: "s", kind: "gauge", buckets: [{ t: times[2]!, v: 0.26 }, { t: times[3]!, v: 0.25 }], stat: 0.255 },
      ],
    });
    const lines = sparkLines(times, moved);
    expect(lines.map((l) => l.vals)).toEqual([
      [240, 250, null, null],
      [null, null, 0.26, 0.25],
    ]);
    const html = renderToStaticMarkup(
      createElement(MetricSpark, { times, result: moved, readingWord: "avg", kindWord: "gauge", name: "d", window: "1h", live: false, marks: [deploy({})] }),
    ).replace(/<!-- -->/g, "");
    expect(html.match(/<svg[^>]*viewBox="0 0 100 100"/g)).toHaveLength(1);
    expect(html).toContain("api v2.0 · 12:57");
    const unmarked = renderToStaticMarkup(
      createElement(MetricSpark, { times, result: moved, readingWord: "avg", kindWord: "gauge", name: "d", window: "1h", live: false }),
    ).replace(/<!-- -->/g, "");
    expect(unmarked).not.toContain("api v2.0");
  });

  test("a Stat shows the line in the unit last sent, never a sum across units", () => {
    expect(metricStat(split)).toEqual({ stat: 0.25, unit: "s" });
    expect(metricStat(result({ stat: 7, unit: "ms" }))).toEqual({ stat: 7, unit: "ms" });
  });
});
