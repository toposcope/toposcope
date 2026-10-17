import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ingestMetricsRoute } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { metricLabelKeys, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #104: disk sellable, sold and used took three panels; split by `basis` they are three lines on one.
const run = Date.now();
const disk = `split_test.disk.${run}`;
const plan = `split_test.plan.${run}`;
const minute = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const window = { from: iso(minute - 60_000), to: iso(minute + 2 * 60_000) };

const app = new Hono();
app.post("/v1/metrics", ingestMetricsRoute);
const post = (body: unknown) =>
  app.request("/v1/metrics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  const points = [
    ...[400, 400].map((value) => ({ name: disk, value, unit: "GiBy", labels: { basis: "sellable", box: "host-01" } })),
    ...[320, 320].map((value) => ({ name: disk, value, unit: "GiBy", labels: { basis: "sold", box: "host-01" } })),
    ...[100, 120].map((value) => ({ name: disk, value, unit: "GiBy", labels: { basis: "used", box: "host-02" } })),
    // 11 plans: the 8 with the most points, and `other`.
    ...Array.from({ length: 11 }, (_, i) =>
      Array.from({ length: 11 - i }, () => ({ name: plan, value: i + 1, labels: { plan: `p${String(i).padStart(2, "0")}` } })),
    ).flat(),
  ].map((p) => ({ ...p, ts: iso(minute + 1_000) }));
  expect((await post(points)).status).toBe(200);
});

describe("a metric split by one label (#104)", () => {
  test("one line per value, each read the way the metric is", async () => {
    if (!ready) return;
    let result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: disk, labels: {}, split: "basis" });
    for (let i = 0; i < 20 && (result.splits?.length ?? 0) < 3; i++) {
      await Bun.sleep(100);
      result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: disk, labels: {}, split: "basis" });
    }
    expect(result.split).toBe("basis");
    expect(result.unit).toBe("GiBy");
    const byKey = Object.fromEntries((result.splits ?? []).map((s) => [s.key, s.stat]));
    expect(byKey).toEqual({ sellable: 400, sold: 320, used: 110 });
    expect(result.splits!.every((s) => s.buckets.length === 1)).toBe(true);
  });

  test("past 8 values the rest are `other`", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: plan, labels: {}, split: "plan" });
    expect(result.splits!.map((s) => s.key)).toEqual(["p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "other"]);
    // p08, p09, p10: 3 + 2 + 1 points of 9, 10, 11 — a gauge's average over all of them.
    expect(result.splits!.at(-1)!.stat).toBeCloseTo((3 * 9 + 2 * 10 + 1 * 11) / 6, 6);
  });

  test("a label matcher still narrows a split", async () => {
    if (!ready) return;
    const result = await searchMetricSeries({ ...window, intervalMs: 60_000, name: disk, labels: { box: "host-01" }, split: "basis" });
    expect(result.splits!.map((s) => s.key).sort()).toEqual(["sellable", "sold"]);
  });

  test("the split picker lists the metric's label keys with their values", async () => {
    if (!ready) return;
    expect(await metricLabelKeys({ name: disk, ...window })).toEqual([
      { key: "basis", values: 3 },
      { key: "box", values: 2 },
    ]);
  });
});
