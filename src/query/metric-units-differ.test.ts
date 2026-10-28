import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { bucketQuantile, bucketSums } from "../shared/histogram-quantile";
import { forgetMetricDescriptions } from "../shared/metric-descriptions";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { forgetMetricUnits } from "../shared/metric-units";
import { migrateStore } from "../shared/migrate";
import { metricLabelKeys, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #331: points pulled from other instances carry their kind, unit and the instance they entered at.
// A panel splits by what disagrees and says so; it never sums ms with s.
const run = Date.now();
const dur = `units_test.dur.${run}`;
const moved = `units_test.moved.${run}`;
const reqs = `units_test.requests.${run}`;
const mixed = `units_test.mixed.${run}`;
const older = `units_test.older.${run}`;
const lat = `units_test.latency.${run}`;
const lat2 = `units_test.latency2.${run}`;
const minute = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const window = { from: iso(minute - 60_000), to: iso(minute + 6 * 60_000) };

type Point = { ts: number; name: string; value: number; kind?: string; unit?: string; toposcope: string; labels?: Record<string, string> };
type Buckets = { ts: number; name: string; le: number[]; n: number[]; unit: string; toposcope: string };

async function insertPoints(points: Point[]): Promise<void> {
  await clickhouseInsertJsonEachRow(
    points
      .map((p) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(iso(p.ts)),
          name: p.name,
          value: p.value,
          labels: p.labels ?? {},
          kind: p.kind ?? "",
          unit: p.unit ?? "",
          toposcope: p.toposcope,
        }),
      )
      .join("\n"),
    "metrics",
  );
}

async function insertBuckets(rows: Buckets[]): Promise<void> {
  await clickhouseInsertJsonEachRow(
    rows
      .map((r) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(iso(r.ts)),
          name: r.name,
          labels: {},
          le: r.le,
          n: r.n,
          kind: "histogram",
          unit: r.unit,
          toposcope: r.toposcope,
        }),
      )
      .join("\n"),
    "metric_buckets",
  );
}

const at = (m: number) => minute + m * 60_000 + 1_000;
const le = [10, 100, 1000];
const edge1 = { le, n: [10, 60, 25, 5] };
const edge2 = { le, n: [40, 50, 9, 1] };
const here = { le, n: [0, 20, 70, 10] };

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  await insertPoints([
    // One gauge, sent in ms by edge-1 and in s by this instance.
    { ts: at(1), name: dur, value: 400, kind: "gauge", unit: "ms", toposcope: "edge-1" },
    { ts: at(1), name: dur, value: 420, kind: "gauge", unit: "ms", toposcope: "edge-1" },
    { ts: at(1), name: dur, value: 0.25, kind: "gauge", unit: "s", toposcope: "here" },
    // A unit changed by a deploy at one source: ms up to minute 2, s from minute 4.
    { ts: at(1), name: moved, value: 240, kind: "gauge", unit: "ms", toposcope: "here" },
    { ts: at(2), name: moved, value: 250, kind: "gauge", unit: "ms", toposcope: "here" },
    { ts: at(4), name: moved, value: 0.26, kind: "gauge", unit: "s", toposcope: "here" },
    // A counter from three sources, one unit: split by source it is one line each.
    { ts: at(1), name: reqs, value: 412, kind: "counter", unit: "{request}", toposcope: "edge-1" },
    { ts: at(1), name: reqs, value: 301, kind: "counter", unit: "{request}", toposcope: "edge-2" },
    { ts: at(1), name: reqs, value: 527, kind: "counter", unit: "{request}", toposcope: "here" },
    { ts: at(2), name: reqs, value: 100, kind: "counter", unit: "{request}", toposcope: "here" },
    // One name sent as a counter by one source and as a gauge by another: summed and averaged apart.
    { ts: at(1), name: mixed, value: 5, kind: "counter", toposcope: "edge-1" },
    { ts: at(1), name: mixed, value: 7, kind: "counter", toposcope: "edge-1" },
    { ts: at(1), name: mixed, value: 10, kind: "gauge", toposcope: "here" },
    { ts: at(1), name: mixed, value: 20, kind: "gauge", toposcope: "here" },
    // Stored before units travelled: no unit on the old points, one on the new. One line.
    { ts: at(1), name: older, value: 10, toposcope: "here" },
    { ts: at(2), name: older, value: 30, kind: "gauge", unit: "ms", toposcope: "here" },
    // A histogram's count and sum: edge-1 in ms, this instance in s.
    { ts: at(1), name: `${lat2}.count`, value: 100, kind: "counter", toposcope: "edge-1" },
    { ts: at(1), name: `${lat2}.sum`, value: 30_000, kind: "counter", unit: "ms", toposcope: "edge-1" },
    { ts: at(1), name: `${lat2}.count`, value: 50, kind: "counter", toposcope: "here" },
    { ts: at(1), name: `${lat2}.sum`, value: 10, kind: "counter", unit: "s", toposcope: "here" },
    { ts: at(1), name: `${lat}.count`, value: 300, kind: "counter", toposcope: "edge-1" },
  ]);
  await insertBuckets([
    // One histogram from three sources, all in ms.
    { ts: at(1), name: lat, unit: "ms", toposcope: "edge-1", ...edge1 },
    { ts: at(1), name: lat, unit: "ms", toposcope: "edge-2", ...edge2 },
    { ts: at(1), name: lat, unit: "ms", toposcope: "here", ...here },
    // Another, from two sources in two units.
    { ts: at(1), name: lat2, unit: "ms", toposcope: "edge-1", ...edge1 },
    { ts: at(1), name: lat2, unit: "s", toposcope: "here", ...here },
  ]);
  forgetMetricKinds();
  forgetMetricUnits();
  forgetMetricDescriptions();
});

const keyed = (result: Awaited<ReturnType<typeof searchMetricSeries>>) =>
  Object.fromEntries((result.splits ?? []).map((s) => [s.key, s.stat]));

describe("a name sent with two units is two lines, and says so (#331)", () => {
  test("never summed: one line for each unit, with the sources it came from", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: dur, labels: {} });
    expect(keyed(result)).toEqual({ ms: 410, s: 0.25 });
    expect(result.splits!.map((s) => s.unit)).toEqual(["ms", "s"]);
    expect(result.units_differ!.map(({ kind, unit, sources }) => ({ kind, unit, sources }))).toEqual([
      { kind: "gauge", unit: "ms", sources: ["edge-1"] },
      { kind: "gauge", unit: "s", sources: ["here"] },
    ]);
    expect(result.buckets).toEqual([]);
    expect(result.stat).toBeNull();
  });

  test("split by toposcope, each source's line is named with its unit", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: dur, labels: {}, split: "toposcope" });
    expect(result.split).toBe("toposcope");
    expect(keyed(result)).toEqual({ "edge-1 · ms": 410, "here · s": 0.25 });
  });

  test("a unit changed at a deploy: the old line ends and the new one starts", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: moved, labels: {} });
    const [ms, s] = result.splits!;
    expect(ms!.key).toBe("ms");
    expect(ms!.buckets.map((b) => b.t)).toEqual([iso(minute + 60_000), iso(minute + 120_000)]);
    expect(s!.key).toBe("s");
    expect(s!.buckets.map((b) => b.t)).toEqual([iso(minute + 240_000)]);
    const groups = result.units_differ!;
    expect(groups.map((g) => g.unit)).toEqual(["ms", "s"]);
    expect(Date.parse(groups[0]!.last)).toBeLessThan(Date.parse(groups[1]!.first));
  });

  test("a counter and a gauge of one name are read each its own way", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: mixed, labels: {} });
    expect(keyed(result)).toEqual({ counter: 12, gauge: 15 });
    expect(result.units_differ!.map((g) => g.kind)).toEqual(["counter", "gauge"]);
  });

  test("points with no unit beside points with one stay one line, as before", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: older, labels: {} });
    expect(result.splits).toBeUndefined();
    expect(result.units_differ).toBeUndefined();
    expect(result.stat).toBe(20);
    expect(result.unit).toBe("ms");
  });

  test("a histogram's average pairs each count with the sum sent beside it", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: lat2, reading: "avg", labels: {} });
    expect(keyed(result)).toEqual({ ms: 300, s: 0.2 });
  });

  test("a histogram's p99 in two units is read within each unit", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: lat2, reading: "p99", labels: {} });
    expect(keyed(result)).toEqual({
      ms: bucketQuantile(0.99, bucketSums([...le, Infinity], edge1.n)),
      s: bucketQuantile(0.99, bucketSums([...le, Infinity], here.n)),
    });
  });

  test("the minute rollup, keyed by kind and unit, gives the lines the stored points give", async () => {
    if (!ready) return;
    // Minute bars with no matcher read the rollup; a 10 s bar reads the points.
    for (const [name, reading] of [[dur, null], [mixed, null], [lat2, "p99"]] as const) {
      const rolled = await searchMetricSeries({ ...window, intervalMs: 60_000, name, reading, labels: {} });
      const scanned = await searchMetricSeries({ ...window, intervalMs: 10_000, name, reading, labels: {} });
      expect(keyed(rolled)).toEqual(keyed(scanned));
      expect(rolled.units_differ!.map((g) => [g.kind, g.unit, g.sources])).toEqual(scanned.units_differ!.map((g) => [g.kind, g.unit, g.sources]));
    }
  });

  test("a heatmap over two units draws as its p99 lines, never one grid", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: lat2, reading: "heatmap", labels: {} });
    expect(result.heat).toBeUndefined();
    expect(result.splits!.map((s) => s.key)).toEqual(["ms", "s"]);
  });
});

describe("a panel split by the instance a point entered at (#331)", () => {
  test("one line per source, read as the metric is", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: reqs, labels: {}, split: "toposcope" });
    expect(result.units_differ).toBeUndefined();
    expect(keyed(result)).toEqual({ here: 627, "edge-1": 412, "edge-2": 301 });
  });

  test("its p99 is the p99 of every source's buckets summed by hand", async () => {
    if (!ready) return;
    const summed = edge1.n.map((n, i) => n + edge2.n[i]! + here.n[i]!);
    const all = await searchMetricSeries({ ...window, intervalMs: 60_000, name: lat, reading: "p99", labels: {} });
    expect(all.stat).toBe(bucketQuantile(0.99, bucketSums([...le, Infinity], summed)));
    const split = await searchMetricSeries({ ...window, intervalMs: 60_000, name: lat, reading: "p99", labels: {}, split: "toposcope" });
    expect(keyed(split)).toEqual({
      "edge-1": bucketQuantile(0.99, bucketSums([...le, Infinity], edge1.n)),
      "edge-2": bucketQuantile(0.99, bucketSums([...le, Infinity], edge2.n)),
      here: bucketQuantile(0.99, bucketSums([...le, Infinity], here.n)),
    });
  });

  test("a matcher on toposcope keeps one source's points", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: reqs, labels: { toposcope: "edge-2" } });
    expect(result.stat).toBe(301);
  });

  test("the split picker offers toposcope once points came from more than one instance", async () => {
    if (!ready) return;
    expect(await metricLabelKeys({ name: reqs, ...window })).toEqual([{ key: "toposcope", values: 3 }]);
    expect(await metricLabelKeys({ name: older, ...window })).toEqual([]);
  });
});
