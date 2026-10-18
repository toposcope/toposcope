import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ingestMetricsRoute } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { forgetMetricDescriptions } from "../shared/metric-descriptions";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { forgetMetricUnits } from "../shared/metric-units";
import { migrateStore } from "../shared/migrate";
import { metricNames, searchMetricSeries } from "./metric-series";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #167: agental said what each metric is, and nothing kept it.
const run = Date.now();
const stranded = `description_test.stranded.${run}`;
const duration = `description_test.duration.${run}`;
const plain = `description_test.plain.${run}`;
const strandedSays = "Free disk nobody can be sold because vCPUs or memory ran out first, by basis, in GiB.";
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

const forget = () => {
  forgetMetricKinds();
  forgetMetricUnits();
  forgetMetricDescriptions();
};

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
  forget();
  expect(
    (await post({ name: stranded, value: 17.2, unit: "GiBy", description: strandedSays, ts: iso(minute + 1_000) })).status,
  ).toBe(200);
  expect((await post({ name: plain, value: 3, ts: iso(minute + 1_000) })).status).toBe(200);
  const otlp = await post({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: `description-${run}` } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: duration,
                unit: "s",
                description: "How long a request took.",
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
  forget();
});

async function listed(name: string) {
  const { keys } = await metricNames({ ...window, find: name });
  return keys.find((row) => row.k === name);
}

describe("a metric is kept with its description", () => {
  test("a JSON point's description comes back with its name and its series", async () => {
    if (!ready) return;
    expect((await listed(stranded))?.description).toBe(strandedSays);
    const series = await searchMetricSeries({ ...window, intervalMs: 60_000, name: stranded, labels: {} });
    expect(series.description).toBe(strandedSays);
    expect(series.unit).toBe("GiBy");
  });

  test("an OTLP histogram's description comes back on its row and on every reading, its count included", async () => {
    if (!ready) return;
    expect((await listed(duration))?.description).toBe("How long a request took.");
    const read = (reading: "p99" | "count") =>
      searchMetricSeries({ ...window, intervalMs: 60_000, name: duration, reading, labels: {} });
    expect((await read("p99")).description).toBe("How long a request took.");
    expect((await read("count")).description).toBe("How long a request took.");
  });

  test("a name sent without a description carries no description key", async () => {
    if (!ready) return;
    const row = await listed(plain);
    expect(row).toBeDefined();
    expect(row && "description" in row).toBe(false);
    const series = await searchMetricSeries({ ...window, intervalMs: 60_000, name: plain, labels: {} });
    expect("description" in series).toBe(false);
  });

  test("the last description sent wins; a point without one does not clear it", async () => {
    if (!ready) return;
    expect(
      (await post({ name: stranded, value: 17.4, description: "Free disk that cannot be sold.", ts: iso(minute + 2_000) })).status,
    ).toBe(200);
    expect((await post({ name: stranded, value: 17.5, ts: iso(minute + 3_000) })).status).toBe(200);
    forget();
    expect((await listed(stranded))?.description).toBe("Free disk that cannot be sold.");
  });

  test("a 301-character description on a JSON point is refused", async () => {
    if (!ready) return;
    const res = await post({ name: stranded, value: 1, description: "x".repeat(301) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Metric description is longer than 300 characters" });
  });
});
