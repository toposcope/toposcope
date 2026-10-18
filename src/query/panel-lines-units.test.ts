import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSavedSearch } from "../control/saved-searches";
import { ingestMetricsRoute } from "../ingest/metrics";
import { pingClickHouse } from "../shared/clickhouse";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { forgetMetricUnits } from "../shared/metric-units";
import { migrateStore } from "../shared/migrate";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #169: a panel draws one unit on one axis; merging vCPUs onto a GiB panel is refused.
const run = Date.now();
const sellable = `lines_test.disk.sellable.${run}`;
const sold = `lines_test.disk.sold.${run}`;
const vcpu = `lines_test.vcpu.sold.${run}`;
const fresh = `lines_test.not_sent_yet.${run}`;

const app = new Hono();
app.post("/v1/metrics", ingestMetricsRoute);
app.post("/api/saved-searches", createSavedSearch);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const panel = (lines: string[]) => ({
  name: `Disk ${run}`,
  query: "",
  range: "24h",
  widgets: {
    logs: false,
    widgets: [
      {
        id: "a",
        kind: "timeseries",
        x: 0,
        y: 0,
        w: 12,
        h: 4,
        replaceY: true,
        metric: sellable,
        metricLabels: {},
        lines: lines.map((metric) => ({ metric, labels: {} })),
        names: { "0": "Capacity", "1": "Promised" },
      },
    ],
  },
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
  for (const [name, unit] of [[sellable, "GiBy"], [sold, "GiBy"], [vcpu, "{vcpu}"]] as const) {
    expect((await post("/v1/metrics", { name, value: 1, unit })).status).toBe(200);
  }
  forgetMetricUnits();
});

describe("merging metrics on a saved panel", () => {
  test("metrics of one unit are saved together", async () => {
    if (!ready) return;
    const res = await post("/api/saved-searches", panel([sold]));
    expect(res.status).toBe(201);
  });

  test("a metric in another unit is refused, naming the line and both units", async () => {
    if (!ready) return;
    const res = await post("/api/saved-searches", panel([sold, vcpu]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `widgets[0].lines[1]: ${vcpu} is {vcpu}, the panel is GiBy` });
  });

  test("a metric not sent yet has no unit to compare, and is let through", async () => {
    if (!ready) return;
    const res = await post("/api/saved-searches", panel([fresh]));
    expect(res.status).toBe(201);
  });
});
