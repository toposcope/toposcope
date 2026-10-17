import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clickhouseCommand, clickhouseQuery, pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { setHereName } from "../shared/here";
import { insertEvents } from "../ingest/index";
import { compileQuery } from "./compile";
import { rollupSource } from "./histogram";
import { search } from "./index";

const minute = 60_000;

describe("the `toposcope` field (#134)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the toposcope field");
    await migrateStore();
  });
  afterAll(() => setHereName(null));

  test("a named instance answers toposcope:<name> from the rollups with the unfiltered total", async () => {
    const tag = Date.now().toString(36);
    const name = `prod-eu-${tag}`;
    const service = `topo${tag}`;
    setHereName(name);
    const at = Math.floor((Date.now() - 10 * minute) / minute) * minute;
    await insertEvents(
      Array.from({ length: 12 }, (_, i) => ({
        ts: new Date(at + i * 1_000).toISOString(),
        service,
        level: i % 3 === 0 ? ("error" as const) : ("info" as const),
        message: `row ${i}`,
      })),
    );
    const window = { from: new Date(at - 5 * minute).toISOString(), to: new Date(at + 5 * minute).toISOString() };
    expect(rollupSource(compileQuery(`toposcope:${name} service:${service}`))).toBe("minute");
    const all = await search({ ...window, q: `service:${service}` });
    const here = await search({ ...window, q: `toposcope:${name} service:${service}` });
    const errors = await search({ ...window, q: `toposcope:${name} service:${service} level:error` });
    expect(all.total).toBe(12);
    expect(here.total).toBe(all.total);
    expect(errors.total).toBe(4);
    expect(here.events.every((e) => e.toposcope === name)).toBe(true);
    const elsewhere = await search({ ...window, q: `toposcope:prod-us-${tag} service:${service}` });
    expect(elsewhere.total).toBe(0);
  });

  test("an unnamed instance stores and searches exactly as before", async () => {
    const service = `untopo${Date.now().toString(36)}`;
    setHereName(null);
    const at = Date.now() - 5 * minute;
    await insertEvents([{ ts: new Date(at).toISOString(), service, level: "info", message: "plain" }]);
    const window = { from: new Date(at - minute).toISOString(), to: new Date(at + minute).toISOString() };
    const result = await search({ ...window, q: `service:${service}` });
    expect(result.total).toBe(1);
    expect(result.events[0]?.toposcope).toBeUndefined();
    const rows = await clickhouseQuery<{ t: string }>(
      "SELECT toposcope AS t FROM logs WHERE service = {service:String}",
      { service },
    );
    expect(rows).toEqual([{ t: "" }]);
  });

  test("an attr a sender calls toposcope is dropped, as level and service are", async () => {
    const tag = Date.now().toString(36);
    const service = `spoof${tag}`;
    setHereName(`here-${tag}`);
    const at = Date.now() - 5 * minute;
    await insertEvents([
      { ts: new Date(at).toISOString(), service, level: "info", message: "spoof", attrs: { toposcope: "elsewhere", kept: "yes" } },
    ]);
    const rows = await clickhouseQuery<{ t: string; m: string }>(
      "SELECT toposcope AS t, toJSONString(attr_map) AS m FROM logs WHERE service = {service:String}",
      { service },
    );
    expect(rows[0]?.t).toBe(`here-${tag}`);
    expect(JSON.parse(rows[0]?.m ?? "{}")).toEqual({ kept: "yes" });
  });
});

describe("the `toposcope` migration (#134) keeps every row and rollup", () => {
  const database = `topo_mig_${Date.now()}`;
  const realUrl = process.env.CLICKHOUSE_URL;

  afterAll(async () => {
    process.env.CLICKHOUSE_URL = realUrl;
    await clickhouseCommand(`DROP DATABASE IF EXISTS ${database}`);
  });

  test("rollups made before it gain the column at the end of their key and keep their rows", async () => {
    await clickhouseCommand(`CREATE DATABASE IF NOT EXISTS ${database}`);
    const url = new URL(realUrl ?? "http://127.0.0.1:8123");
    url.searchParams.set("database", database);
    process.env.CLICKHOUSE_URL = url.toString();
    // The 0.5.4 shapes: no `seq`, no `toposcope`.
    await clickhouseCommand(`CREATE TABLE logs (
      tenant_id LowCardinality(String) DEFAULT 'default', ts DateTime64(3, 'UTC'), service LowCardinality(String),
      host LowCardinality(String) DEFAULT '', level LowCardinality(String), message String, attrs String DEFAULT '{}',
      attr_map Map(LowCardinality(String), String) DEFAULT map(), trace_id String DEFAULT ''
    ) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (tenant_id, service, ts)`);
    await clickhouseCommand(`CREATE TABLE logs_by_minute (
      tenant_id LowCardinality(String), minute DateTime('UTC'), service LowCardinality(String),
      level LowCardinality(String), host LowCardinality(String), n AggregateFunction(count)
    ) ENGINE = AggregatingMergeTree PARTITION BY toDate(minute) ORDER BY (tenant_id, minute, service, level, host)`);
    await clickhouseCommand(`CREATE TABLE logs_attr_keys_by_minute (
      tenant_id LowCardinality(String), minute DateTime('UTC'), service LowCardinality(String),
      level LowCardinality(String), host LowCardinality(String), key LowCardinality(String), n AggregateFunction(count)
    ) ENGINE = AggregatingMergeTree PARTITION BY toDate(minute) ORDER BY (tenant_id, minute, service, level, host, key)`);
    const day = new Date(Date.now() - 60 * minute).toISOString().slice(0, 19).replace("T", " ");
    await clickhouseCommand(
      `INSERT INTO logs (ts, service, level, message, attr_map) VALUES ('${day}', 'api', 'error', 'old row', map('status', '500'))`,
    );
    await clickhouseCommand(
      `INSERT INTO logs_by_minute SELECT tenant_id, toStartOfMinute(ts), service, level, host, countState() FROM logs GROUP BY tenant_id, toStartOfMinute(ts), service, level, host`,
    );
    await clickhouseCommand(
      `INSERT INTO logs_attr_keys_by_minute SELECT tenant_id, toStartOfMinute(ts), service, level, host, key, countState() FROM logs ARRAY JOIN mapKeys(attr_map) AS key GROUP BY tenant_id, toStartOfMinute(ts), service, level, host, key`,
    );

    await migrateStore();

    const keys = await clickhouseQuery<{ name: string; sorting_key: string }>(
      `SELECT name, sorting_key FROM system.tables WHERE database = {db:String} AND name IN ('logs_by_minute', 'logs_attr_keys_by_minute') ORDER BY name`,
      { db: database },
    );
    expect(keys).toEqual([
      { name: "logs_attr_keys_by_minute", sorting_key: "tenant_id, minute, service, level, host, key, toposcope" },
      { name: "logs_by_minute", sorting_key: "tenant_id, minute, service, level, host, toposcope" },
    ]);
    const counts = await clickhouseQuery<{ n: string | number; t: string }>(
      "SELECT countMerge(n) AS n, any(toposcope) AS t FROM logs_by_minute",
    );
    expect(Number(counts[0]?.n)).toBe(1);
    expect(counts[0]?.t).toBe("");
    const keyCounts = await clickhouseQuery<{ n: string | number }>(
      "SELECT countMerge(n) AS n FROM logs_attr_keys_by_minute WHERE key = 'status'",
    );
    expect(Number(keyCounts[0]?.n)).toBe(1);
    const old = await clickhouseQuery<{ message: string; seq: string | number; toposcope: string }>(
      "SELECT message, seq, toposcope FROM logs",
    );
    expect(old.map((r) => ({ message: r.message, seq: Number(r.seq), toposcope: r.toposcope }))).toEqual([
      { message: "old row", seq: 0, toposcope: "" },
    ]);
  });
});
