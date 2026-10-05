import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { search } from "./index";
import { searchMetricSeries } from "./metric-series";

describe("compare window reads ClickHouse", () => {
  let ready = false;
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    ready = await pingClickHouse();
    if (ready) await migrateStore();
  });

  test("exact compare counts exclude partial-minute edges and the shared mark boundary", async () => {
    if (!ready) return;
    const minute = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
    const service = `compare${Date.now()}`;
    await clickhouseInsertJsonEachRow([10_000, 25_000, 40_000, 50_000].map((offset) => JSON.stringify({
      tenant_id: "default", ts: toClickHouseDateTime(new Date(minute + offset).toISOString()),
      service, host: "visible", level: "error", message: "compare boundary", attrs: "{}", attr_map: {}, trace_id: "",
    })).join("\n"));
    const result = await search({
      from: new Date(minute + 20_000).toISOString(), to: new Date(minute + 40_000).toISOString(),
      q: `service:${service}`, split: "host", keep: ["visible"], step: "1m", events: "0", exact: true,
    });
    expect(result.total).toBe(1);
    expect(result.histogram.reduce((sum, bucket) => sum + (bucket.series.visible ?? 0), 0)).toBe(1);
  });

  test("metric other averages the samples outside the plotted named keys", async () => {
    if (!ready) return;
    const minute = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
    const name = `compare${Date.now()}`;
    await clickhouseInsertJsonEachRow([
      { host: "visible", value: 1000 }, { host: "hidden-a", value: 10 }, { host: "hidden-b", value: 20 },
    ].map(({host,value}) => JSON.stringify({tenant_id:"default", ts:toClickHouseDateTime(new Date(minute+25_000).toISOString()), name,value,labels:{host}})).join("\n"), "metrics");
    const result = await searchMetricSeries({
      from: new Date(minute + 20_000).toISOString(), to: new Date(minute + 40_000).toISOString(),
      intervalMs: 60_000, name, labels: {}, exact: true, exclude: {key: "host", values: ["visible"]},
    });
    expect(result.stat).toBe(15);
    expect(result.buckets.map((bucket) => bucket.v)).toEqual([15]);
  });
});
