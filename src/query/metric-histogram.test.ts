import { beforeAll, describe, expect, test } from "bun:test";
import { insertMetricBuckets, insertMetricPoints } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import type { HistogramReading } from "../shared/metric";
import { forgetMetricKinds, rememberMetricKinds } from "../shared/metric-kinds";
import { migrateStore } from "../shared/migrate";
import { metricNames, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

const run = Date.now();
const latency = `hist_test.latency.${run}`;
/** A histogram stored before buckets were kept: its count and sum, and no kind of its own. */
const older = `hist_test.older.${run}`;
/** A histogram with nothing in this window. */
const quiet = `hist_test.quiet.${run}`;
// Two whole minutes, well inside the window.
const second = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const first = second - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const from = iso(first - 60_000);
const to = iso(second + 2 * 60_000);
const api = { service: `hist-api-${run}` };
const worker = { service: `hist-worker-${run}` };
const le = [100, 200, 400];

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  forgetMetricKinds();
  await rememberMetricKinds(
    new Map([
      [latency, "histogram"],
      [`${latency}.count`, "counter"],
      [`${latency}.sum`, "counter"],
      [quiet, "histogram"],
      [`${older}.count`, "counter"],
      [`${older}.sum`, "counter"],
    ]),
  );
  /** One export of one series: what it observed, by bucket, and what that added up to. */
  const sent = (ts: number, labels: Record<string, string>, n: number[], sum: number) => ({
    buckets: { ts: iso(ts), name: latency, labels, le, n },
    points: [
      { ts: iso(ts), name: `${latency}.count`, value: n.reduce((a, b) => a + b, 0), labels },
      { ts: iso(ts), name: `${latency}.sum`, value: sum, labels },
    ],
  });
  const exports = [
    // The first minute: the api is fast, the worker slow.
    sent(first + 1_000, api, [50, 40, 10, 0], 13_000),
    sent(first + 1_000, worker, [0, 0, 100, 0], 30_000),
    // The second: ten quick ones from the api.
    sent(second + 1_000, api, [10, 0, 0, 0], 500),
  ];
  await insertMetricBuckets(exports.map((row) => row.buckets));
  await insertMetricPoints([
    ...exports.flatMap((row) => row.points),
    { ts: iso(first + 1_000), name: `${older}.count`, value: 7, labels: api },
    { ts: iso(first + 1_000), name: `${older}.sum`, value: 21, labels: api },
  ]);
});

async function read(reading: HistogramReading | null, labels: Record<string, string> = {}, intervalMs = 60_000) {
  const series = await searchMetricSeries({ from, to, intervalMs: intervalMs as 60_000, name: latency, reading, labels });
  return { bars: series.buckets.map((bucket) => bucket.v), stat: series.stat };
}

describe("a histogram is read one way at a time", () => {
  test("count is how many were observed in each bar", async () => {
    if (!ready) return;
    expect(await read("count")).toEqual({ bars: [200, 10], stat: 210 });
  });

  test("sum is what they added up to", async () => {
    if (!ready) return;
    expect(await read("sum")).toEqual({ bars: [43_000, 500], stat: 43_500 });
  });

  test("avg is the sum over the count, not an average of averages", async () => {
    if (!ready) return;
    expect(await read("avg")).toEqual({ bars: [215, 50], stat: 43_500 / 210 });
  });

  test("a percentile is read off the buckets of every series added together", async () => {
    if (!ready) return;
    // First minute, both services: 50 up to 100, 40 up to 200, 110 up to 400.
    const p50 = await read("p50");
    expect(p50.bars[0]).toBeCloseTo(200 + 200 * (10 / 110), 6);
    expect(p50.bars[1]).toBeCloseTo(50, 6);
    // The whole window is one histogram too: 60, 40, 110.
    expect(p50.stat).toBeCloseTo(200 + 200 * (5 / 110), 6);
    // The api's median alone is 100 and the worker's 300; their average, 200, is not the answer.
    expect(p50.bars[0]).not.toBeCloseTo(200, 3);
    expect((await read("p90")).bars[0]).toBeCloseTo(200 + 200 * (90 / 110), 6);
    expect((await read("p99")).bars[0]).toBeCloseTo(200 + 200 * (108 / 110), 6);
  });

  test("with no reading asked for, it is the p99", async () => {
    if (!ready) return;
    const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name: latency, labels: {} });
    expect(series.reading).toBe("p99");
    expect(series.buckets[0]!.v).toBeCloseTo(200 + 200 * (108 / 110), 6);
  });

  test("a label matcher reads one service's buckets", async () => {
    if (!ready) return;
    expect((await read("p50", api)).bars).toEqual([100, 50]);
    expect((await read("p50", worker)).bars).toEqual([300]);
    expect(await read("count", worker)).toEqual({ bars: [100], stat: 100 });
    expect(await read("avg", worker)).toEqual({ bars: [300], stat: 300 });
  });

  test("bars finer than a minute read the stored buckets", async () => {
    if (!ready) return;
    const fine = await read("p50", {}, 10_000);
    expect(fine.bars).toHaveLength(2);
    expect(fine.bars[0]).toBeCloseTo(200 + 200 * (10 / 110), 6);
  });

  test("the series says what it is, how it was read, and under which name", async () => {
    if (!ready) return;
    const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name: latency, reading: "p90", labels: api });
    expect(series.kind).toBe("histogram");
    expect(series.reading).toBe("p90");
    expect(series.metric).toBe(latency);
    expect(series.expr).toBe(`p90:${latency}{service=${api.service}}`);
  });
});

describe("a link made before buckets were kept", () => {
  test("its `.count` still draws the same line, as the count of the histogram", async () => {
    if (!ready) return;
    const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name: `${latency}.count`, labels: {} });
    expect(series.buckets.map((bucket) => bucket.v)).toEqual([200, 10]);
    expect(series.stat).toBe(210);
    expect(series.kind).toBe("histogram");
    expect(series.reading).toBe("count");
    expect(series.metric).toBe(latency);
  });

  test("its `.sum` is the sum of the histogram", async () => {
    if (!ready) return;
    const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name: `${latency}.sum`, labels: {} });
    expect(series.buckets.map((bucket) => bucket.v)).toEqual([43_000, 500]);
    expect(series.reading).toBe("sum");
  });

  test("a histogram that never sent buckets stays the two counters it was", async () => {
    if (!ready) return;
    const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name: `${older}.count`, labels: {} });
    expect(series.buckets.map((bucket) => bucket.v)).toEqual([7]);
    expect(series.kind).toBe("counter");
    expect(series.reading).toBeUndefined();
  });
});

describe("the list of names", () => {
  test("a histogram is one name of its own kind; its count and sum are not listed beside it", async () => {
    if (!ready) return;
    const { keys, total } = await metricNames({ from, to, find: String(run) });
    expect(keys.map((row) => [row.k, row.kind]).sort()).toEqual([
      [latency, "histogram"],
      [`${older}.count`, "counter"],
      [`${older}.sum`, "counter"],
    ]);
    // Counted by its exports, not by its count and its sum both.
    expect(keys.find((row) => row.k === latency)!.n).toBe(3);
    const everything = await metricNames({ from, to });
    expect(everything.total).toBe(total);
    expect(everything.keys.some((row) => row.k === `${latency}.count` || row.k === `${latency}.sum`)).toBe(false);
  });

  test("it is found by any part of its name, and not by the `.count` it is stored under", async () => {
    if (!ready) return;
    expect((await metricNames({ from, to, find: `LATENCY.${run}` })).keys.map((row) => row.k)).toEqual([latency]);
    expect((await metricNames({ from, to, find: `latency.${run}.count` })).keys).toEqual([]);
  });

  test("a picked histogram is answered for, and an older link's `.count` says which histogram it reads", async () => {
    if (!ready) return;
    const { picked } = await metricNames({ from, to, picked: [latency, `${latency}.count`, quiet, `${older}.count`] });
    expect(picked).toEqual([
      { k: latency, n: 3, kind: "histogram" },
      { k: `${latency}.count`, n: 3, kind: "histogram", of: latency, reading: "count" },
      { k: quiet, n: 0, kind: "histogram" },
      { k: `${older}.count`, n: 1, kind: "counter" },
    ]);
  });
});
