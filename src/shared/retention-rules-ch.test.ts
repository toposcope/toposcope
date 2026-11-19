import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clickhouseCommand, clickhouseQuery, pingClickHouse } from "./clickhouse";
import { applyRetentionDays, migrateStore } from "./migrate";
import { insertEvents } from "../ingest/index";

async function engine(table: string): Promise<string> {
  const rows = await clickhouseQuery<{ e: string }>(
    "SELECT engine_full AS e FROM system.tables WHERE database = currentDatabase() AND name = {t:String}",
    { t: table },
  );
  return rows[0]?.e ?? "";
}

async function services(tag: string): Promise<string[]> {
  const rows = await clickhouseQuery<{ s: string }>(
    "SELECT DISTINCT service AS s FROM logs WHERE startsWith(service, {t:String}) ORDER BY s",
    { t: tag },
  );
  return rows.map((r) => r.s);
}

describe("retention by service on ClickHouse (#477)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for retention rules");
    await migrateStore();
  });

  afterAll(async () => {
    await applyRetentionDays(30, 30, []);
  });

  test("a kept service outlives logs' days; every other service does not", async () => {
    const tag = `rr${Date.now().toString(36)}`;
    const kept = `${tag}-analytics`;
    const other = `${tag}-api`;
    await applyRetentionDays(30, 30, [{ service: kept, days: 730 }]);
    expect(await engine("logs")).toContain(`TTL addDays(toDate(ts), transform(service, ['${kept}'], [730], 30))`);
    expect(await engine("logs_by_minute")).toContain("transform(service,");
    expect(await engine("spans")).toContain("transform(service,");
    expect(await engine("metrics")).not.toContain("transform(");
    const old = new Date(Date.now() - 40 * 86_400_000);
    const ts = old.toISOString();
    await insertEvents([
      { ts, service: kept, level: "info", message: "signed up" },
      { ts, service: other, level: "info", message: "GET /" },
    ]);
    // A TTL merge is throttled per table (merge_with_ttl_timeout), so apply the TTL by mutation.
    await clickhouseCommand(`ALTER TABLE logs MATERIALIZE TTL IN PARTITION '${ts.slice(0, 10)}' SETTINGS mutations_sync = 2`);
    expect(await services(tag)).toEqual([kept]);
  });

  test("the same settings again issue no ALTER", async () => {
    const rules = [{ service: "rr-same", days: 400 }];
    await applyRetentionDays(30, 30, rules);
    const before = await clickhouseQuery<{ n: string }>(
      "SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND table = 'logs'",
    );
    await applyRetentionDays(30, 30, rules);
    const after = await clickhouseQuery<{ n: string }>(
      "SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND table = 'logs'",
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  test("removing every rule puts back today's TTL", async () => {
    await applyRetentionDays(30, 30, [{ service: "rr-x", days: 90 }]);
    await applyRetentionDays(30, 30, []);
    const e = await engine("logs");
    expect(e).not.toContain("transform(");
    expect(e).toMatch(/TTL toDate\(ts\) \+ (toIntervalDay\(30\)|INTERVAL 30 DAY)/);
  });
});
