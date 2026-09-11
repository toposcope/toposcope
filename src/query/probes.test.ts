import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  clickhouseCommand,
  clickhouseInsertJsonEachRow,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { probeToMetricPoint } from "../shared/probe";
import { searchMetricSeries } from "./metric-series";
import { probesRoute, searchProbes } from "./probes";

describe("probesRoute", () => {
  test("requires from/to or range", async () => {
    const app = new Hono();
    app.get("/api/probes", probesRoute);
    const res = await app.request("/api/probes");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "from/to or range is required" });
  });
});

describe("searchProbes ClickHouse", () => {
  test("lists explicit up=0 and the overlay avg follows it", async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
    if (!(await pingClickHouse())) {
      return;
    }
    await clickhouseCommand(`
      CREATE TABLE IF NOT EXISTS metrics (
        tenant_id LowCardinality(String),
        ts DateTime64(3, 'UTC'),
        name LowCardinality(String),
        value Float64,
        labels Map(LowCardinality(String), String)
      )
      ENGINE = MergeTree
      PARTITION BY toDate(ts)
      ORDER BY (tenant_id, name, ts)
      TTL toDate(ts) + INTERVAL 30 DAY
    `);
    const token = `probe${Date.now()}`;
    const from = "2026-08-31T17:00:00.000Z";
    const mark = "2026-08-31T17:30:00.000Z";
    const to = "2026-08-31T18:00:00.000Z";
    const down = "2026-08-31T17:31:00.000Z";
    const points = [
      probeToMetricPoint({
        ts: from,
        service: token,
        host: "",
        check: "",
        target: "",
        up: 1,
        source: "attach",
      }),
      probeToMetricPoint({
        ts: down,
        service: token,
        host: "billing-1",
        check: "github",
        target: "",
        up: 0,
        source: "attach",
      }),
    ];
    await clickhouseInsertJsonEachRow(
      points
        .map((point) =>
          JSON.stringify({
            tenant_id: "default",
            ts: toClickHouseDateTime(point.ts),
            name: point.name,
            value: point.value,
            labels: point.labels,
          }),
        )
        .join("\n"),
      "metrics",
    );

    const listed = await searchProbes({
      from,
      to,
      service: token,
    });
    expect(listed.probes.map((sample) => sample.up)).toEqual([1, 0]);
    expect(listed.probes[1]?.host).toBe("billing-1");
    expect(listed.probes[1]?.check).toBe("github");

    const overlay = await searchMetricSeries({
      from,
      to,
      intervalMs: 60_000,
      name: "up",
      labels: { service: token },
    });
    expect(overlay.source).toBe("metric");
    const zeros = overlay.buckets.filter((bucket) => bucket.v === 0);
    const ones = overlay.buckets.filter((bucket) => bucket.v === 1);
    expect(zeros.length).toBeGreaterThan(0);
    expect(ones.length).toBeGreaterThan(0);
    expect(Date.parse(zeros[0]?.t ?? "")).toBeGreaterThanOrEqual(Date.parse(mark));
  });
});
