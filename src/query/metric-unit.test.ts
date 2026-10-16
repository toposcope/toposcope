import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ingestMetricsRoute } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { forgetMetricUnits } from "../shared/metric-units";
import { migrateStore } from "../shared/migrate";
import { metricNames, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #104: a memory panel read 26.8, and nothing said whether it was percent or GiB.
const run = Date.now();
const memory = `unit_test.memory.${run}`;
const duration = `unit_test.duration.${run}`;
const plain = `unit_test.plain.${run}`;
const minute = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const window = { from: iso(minute - 60_000), to: iso(minute + 2 * 60_000) };
const nano = (ms: number) => `${ms}000000`;

const app = new Hono();
app.post("/v1/metrics", ingestMetricsRoute);
const post = (body: unknown) =>
  app.request("/v1/metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  forgetMetricKinds();
  forgetMetricUnits();
  expect((await post({ name: memory, value: 26.8, unit: "GiBy", ts: iso(minute + 1_000) })).status).toBe(200);
  expect((await post({ name: plain, value: 3, ts: iso(minute + 1_000) })).status).toBe(200);
  const otlp = await post({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: `unit-${run}` } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: duration,
                unit: "s",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      timeUnixNano: nano(minute + 1_000),
                      count: "40",
                      sum: 3.2,
                      bucketCounts: ["30", "10"],
                      explicitBounds: [0.1],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(otlp.status).toBe(200);
  // What a later read finds in the store, not in this process's memory.
  forgetMetricKinds();
  forgetMetricUnits();
});

async function listed(name: string) {
  const { keys } = await metricNames({ ...window, find: name });
  return keys.find((row) => row.k === name);
}

describe("a metric is kept with its unit", () => {
  test("a JSON point's unit comes back with its name and its series", async () => {
    if (!ready) return;
    expect((await listed(memory))?.unit).toBe("GiBy");
    const series = await searchMetricSeries({ ...window, intervalMs: 60_000, name: memory, labels: {} });
    expect(series.unit).toBe("GiBy");
  });

  test("an OTLP histogram's unit comes back on its list row and on the readings of its values", async () => {
    if (!ready) return;
    expect((await listed(duration))?.unit).toBe("s");
    const read = (reading: "p99" | "avg" | "count") =>
      searchMetricSeries({ ...window, intervalMs: 60_000, name: duration, reading, labels: {} });
    expect((await read("p99")).unit).toBe("s");
    expect((await read("avg")).unit).toBe("s");
    // A count is a number of observations, not seconds.
    expect((await read("count")).unit).toBeUndefined();
  });

  test("a name sent without a unit has none", async () => {
    if (!ready) return;
    expect((await listed(plain))?.unit).toBeUndefined();
  });

  test("the last unit sent wins; a point without one does not clear it", async () => {
    if (!ready) return;
    expect((await post({ name: memory, value: 28.1, unit: "GBy", ts: iso(minute + 2_000) })).status).toBe(200);
    expect((await post({ name: memory, value: 28.2, ts: iso(minute + 3_000) })).status).toBe(200);
    forgetMetricUnits();
    expect((await listed(memory))?.unit).toBe("GBy");
  });

  test("a unit that is not a string is refused", async () => {
    if (!ready) return;
    const res = await post({ name: memory, value: 1, unit: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Metric unit must be a string" });
  });
});
