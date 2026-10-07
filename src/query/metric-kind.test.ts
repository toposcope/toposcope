import { beforeAll, describe, expect, test } from "bun:test";
import { insertMetricPoints } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { forgetMetricKinds, metricKind, rememberMetricKinds } from "../shared/metric-kinds";
import { migrateStore } from "../shared/migrate";
import { metricNames, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

const run = Date.now();
const counter = `kind_test.jobs.${run}`;
const gauge = `kind_test.memory.${run}`;
const plain = `kind_test.plain.${run}`;
// Two whole minutes, well inside the window.
const second = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const first = second - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const from = iso(first - 60_000);
const to = iso(second + 2 * 60_000);

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  forgetMetricKinds();
  const labels = { service: `kind-${run}` };
  const points = (name: string) => [
    { ts: iso(first + 1_000), name, value: 5, labels },
    { ts: iso(first + 30_000), name, value: 7, labels },
    { ts: iso(second + 1_000), name, value: 4, labels },
  ];
  await rememberMetricKinds(new Map([[counter, "counter"], [gauge, "gauge"]]));
  await insertMetricPoints([...points(counter), ...points(gauge), ...points(plain)]);
});

/** The two bars the points fall in, and the window's one number. */
async function read(name: string, labels: Record<string, string>) {
  const series = await searchMetricSeries({ from, to, intervalMs: 60_000, name, labels });
  return { bars: series.buckets.map((bucket) => bucket.v), stat: series.stat };
}

describe("a metric is read by the kind it came as", () => {
  test("a counter's bar is the sum of what arrived in it", async () => {
    if (!ready) return;
    expect(await read(counter, {})).toEqual({ bars: [12, 4], stat: 16 });
  });

  test("a gauge's bar is the average of its points", async () => {
    if (!ready) return;
    expect(await read(gauge, {})).toEqual({ bars: [6, 4], stat: 16 / 3 });
  });

  test("a name that never came with a kind reads as a gauge, as before", async () => {
    if (!ready) return;
    expect(await read(plain, {})).toEqual({ bars: [6, 4], stat: 16 / 3 });
  });

  test("a label matcher reads the same way", async () => {
    if (!ready) return;
    const labels = { service: `kind-${run}` };
    expect(await read(counter, labels)).toEqual({ bars: [12, 4], stat: 16 });
    expect(await read(gauge, labels)).toEqual({ bars: [6, 4], stat: 16 / 3 });
  });

  test("the series says how it was read", async () => {
    if (!ready) return;
    expect((await searchMetricSeries({ from, to, intervalMs: 60_000, name: counter, labels: {} })).kind).toBe("counter");
    expect((await searchMetricSeries({ from, to, intervalMs: 60_000, name: plain, labels: {} })).kind).toBe("gauge");
  });

  test("the names of a window come with their kinds, and can be found by any part", async () => {
    if (!ready) return;
    const found = await metricNames({ from, to, find: `JOBS.${run}` });
    expect(found.keys).toEqual([{ k: counter, n: 3, kind: "counter" }]);
    expect(found.total).toBeGreaterThanOrEqual(3);
    const all = await metricNames({ from, to, find: `kind_test.` });
    expect(all.keys.filter((row) => row.k.endsWith(String(run))).map((row) => [row.k, row.kind]).sort()).toEqual(
      [[counter, "counter"], [gauge, "gauge"], [plain, "gauge"]].sort(),
    );
  });

  test("a picked name is answered for with no points in the window, kind and all", async () => {
    if (!ready) return;
    const quiet = await metricNames({
      from: iso(first - 3 * 3_600_000),
      to: iso(first - 2 * 3_600_000),
      picked: [counter, "kind_test.never.sent"],
    });
    expect(quiet.picked).toEqual([
      { k: counter, n: 0, kind: "counter" },
      { k: "kind_test.never.sent", n: 0, kind: "gauge" },
    ]);
    expect((await metricNames({ from, to, picked: [counter] })).picked).toEqual([{ k: counter, n: 3, kind: "counter" }]);
  });

  test("a name remembers its kind across a restart, and the newest kind wins", async () => {
    if (!ready) return;
    forgetMetricKinds();
    expect(await metricKind(counter)).toBe("counter");
    expect(await metricKind(plain)).toBeNull();
    await rememberMetricKinds(new Map([[counter, "gauge"]]));
    forgetMetricKinds();
    expect(await metricKind(counter)).toBe("gauge");
  });
});
