import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseCommand, clickhouseInsertJsonEachRow, clickhouseQuery, pingClickHouse, toClickHouseDateTime } from "./clickhouse";
import { droppedMetricMetaTables, metricRollupKeys, migrateStore } from "./migrate";

process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";

// #331: the per-minute rollups carry kind and unit in their key, and the per-name tables are gone.
const run = Date.now();
const dur = `rollup_test.dur.${run}`;
const lat = `rollup_test.latency.${run}`;
const before = `rollup_test.before.${run}`;
const minute = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
const at = (s: number) => toClickHouseDateTime(new Date(minute + s * 1_000).toISOString());

type Row = Record<string, unknown>;

async function insert(table: "metrics" | "metric_buckets", rows: Row[]): Promise<void> {
  await clickhouseInsertJsonEachRow(rows.map((row) => JSON.stringify({ tenant_id: "default", labels: {}, ...row })).join("\n"), table);
}

async function sortingKey(table: string): Promise<string | undefined> {
  const rows = await clickhouseQuery<{ sorting_key: string }>(
    "SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {table:String}",
    { table },
  );
  return rows[0]?.sorting_key;
}

let ready = false;

beforeAll(async () => {
  ready = await pingClickHouse();
  if (!ready) {
    return;
  }
  await migrateStore();
});

describe("a metric minute rollup keys by kind and unit (#331)", () => {
  test("every metric rollup has kind, unit and toposcope in its key", async () => {
    if (!ready) return;
    expect(await sortingKey("metrics_by_minute")).toBe(metricRollupKeys.metrics_by_minute);
    expect(await sortingKey("metric_buckets_by_minute")).toBe(metricRollupKeys.metric_buckets_by_minute);
    for (const key of Object.values(metricRollupKeys)) {
      expect(key.split(", ")).toEqual(expect.arrayContaining(["kind", "unit", "toposcope"]));
    }
  });

  test("one name sent in ms and in s in the same minute stays two rows, never merged", async () => {
    if (!ready) return;
    await insert("metrics", [
      { ts: at(1), name: dur, value: 400, kind: "gauge", unit: "ms", toposcope: "edge-1" },
      { ts: at(2), name: dur, value: 420, kind: "gauge", unit: "ms", toposcope: "edge-1" },
      { ts: at(3), name: dur, value: 0.25, kind: "gauge", unit: "s", toposcope: "edge-2" },
    ]);
    await clickhouseCommand("OPTIMIZE TABLE metrics_by_minute FINAL");
    const rows = await clickhouseQuery<{ kind: string; unit: string; toposcope: string; n: string | number; v: number }>(
      `SELECT kind, unit, toposcope, countMerge(n) AS n, sumMerge(v_sum) AS v
       FROM metrics_by_minute WHERE name = {name:String}
       GROUP BY kind, unit, toposcope ORDER BY unit`,
      { name: dur },
    );
    expect(rows.map((row) => ({ ...row, n: Number(row.n) }))).toEqual([
      { kind: "gauge", unit: "ms", toposcope: "edge-1", n: 2, v: 820 },
      { kind: "gauge", unit: "s", toposcope: "edge-2", n: 1, v: 0.25 },
    ]);
    const stored = await clickhouseQuery<{ n: string | number }>(
      "SELECT count() AS n FROM metrics_by_minute WHERE name = {name:String}",
      { name: dur },
    );
    expect(Number(stored[0]!.n)).toBe(2);
  });

  test("a histogram's buckets in two units stay two rows for each bound", async () => {
    if (!ready) return;
    await insert("metric_buckets", [
      { ts: at(1), name: lat, le: [10, 100], n: [1, 2, 3], kind: "histogram", unit: "ms", toposcope: "edge-1" },
      { ts: at(2), name: lat, le: [10, 100], n: [4, 5, 6], kind: "histogram", unit: "s", toposcope: "edge-1" },
    ]);
    await clickhouseCommand("OPTIMIZE TABLE metric_buckets_by_minute FINAL");
    const rows = await clickhouseQuery<{ unit: string; le: number | string; n: number }>(
      `SELECT unit, toString(le) AS le, sum(n) AS n FROM metric_buckets_by_minute
       WHERE name = {name:String} GROUP BY unit, le ORDER BY unit, toFloat64(le)`,
      { name: lat },
    );
    expect(rows).toEqual([
      { unit: "ms", le: "10", n: 1 },
      { unit: "ms", le: "100", n: 2 },
      { unit: "ms", le: "inf", n: 3 },
      { unit: "s", le: "10", n: 4 },
      { unit: "s", le: "100", n: 5 },
      { unit: "s", le: "inf", n: 6 },
    ]);
  });

  test("a rollup made with the old key is made again and filled from the stored points", async () => {
    if (!ready) return;
    await insert("metrics", [
      { ts: at(1), name: before, value: 3, kind: "counter", unit: "{request}", toposcope: "" },
      { ts: at(2), name: before, value: 4, kind: "counter", unit: "{request}", toposcope: "" },
    ]);
    // The rollup as 0.10.0 made it: keyed by name and minute alone.
    await clickhouseCommand("DROP VIEW IF EXISTS metrics_by_minute_mv");
    await clickhouseCommand("DROP TABLE IF EXISTS metrics_by_minute");
    await clickhouseCommand(`
      CREATE TABLE metrics_by_minute (
        tenant_id LowCardinality(String),
        minute DateTime('UTC'),
        name LowCardinality(String),
        n AggregateFunction(count),
        v_sum AggregateFunction(sum, Float64),
        v_min AggregateFunction(min, Float64),
        v_max AggregateFunction(max, Float64)
      )
      ENGINE = AggregatingMergeTree
      PARTITION BY toDate(minute)
      ORDER BY (tenant_id, name, minute)
    `);
    await migrateStore();
    expect(await sortingKey("metrics_by_minute")).toBe(metricRollupKeys.metrics_by_minute);
    const rows = await clickhouseQuery<{ kind: string; unit: string; v: number }>(
      "SELECT kind, unit, sumMerge(v_sum) AS v FROM metrics_by_minute WHERE name = {name:String} GROUP BY kind, unit",
      { name: before },
    );
    expect(rows).toEqual([{ kind: "counter", unit: "{request}", v: 7 }]);
  });
});

describe("the per-name metadata tables go (#331)", () => {
  test("boot drops metric_kinds, metric_units and metric_descriptions", async () => {
    if (!ready) return;
    expect([...droppedMetricMetaTables]).toEqual(["metric_kinds", "metric_units", "metric_descriptions"]);
    // As an install before 0.10 left it.
    await clickhouseCommand(
      "CREATE TABLE IF NOT EXISTS metric_kinds (tenant_id LowCardinality(String), name LowCardinality(String), kind LowCardinality(String), seen DateTime64(3, 'UTC')) ENGINE = ReplacingMergeTree(seen) ORDER BY (tenant_id, name)",
    );
    await migrateStore();
    const left = await clickhouseQuery<{ name: string }>(
      "SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN ('metric_kinds', 'metric_units', 'metric_descriptions')",
    );
    expect(left).toEqual([]);
  });

  test("an insert into one of them is refused before it reaches ClickHouse", async () => {
    for (const table of droppedMetricMetaTables) {
      await expect(clickhouseInsertJsonEachRow("{}", table)).rejects.toThrow(`ClickHouse insert table not allowed: ${table}`);
    }
  });
});
