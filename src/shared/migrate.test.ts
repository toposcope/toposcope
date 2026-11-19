import { describe, expect, test } from "bun:test";
import {
  attrNumericMvWhereSql,
  attrRoleSkipSql,
  attrValueMvWhereSql,
  clampMetricsRetentionDays,
  clampRetentionDays,
  clickhouseStringLiteral,
  isMetricsRetentionTable,
  isServiceRetentionTable,
  retentionTtlExpr,
  ttlMatches,
  clickhouseVersionAtLeast,
  isDayPartition,
  killUnfinishedTtlMutationSql,
  logsCreateTableSql,
  messageTextIndexSql,
  parseClickHouseVersion,
  parseTtlIntervalDays,
  retentionTtlAlterSettings,
  retentionTtlAlterSql,
  retentionTtlTables,
  requireClickHouseVersion,
} from "./migrate";

describe("isDayPartition", () => {
  test("accepts ClickHouse toDate partitions", () => {
    expect(isDayPartition("2026-08-14")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isDayPartition("20260814")).toBe(false);
    expect(isDayPartition("2026-08-14; DROP TABLE logs")).toBe(false);
    expect(isDayPartition("")).toBe(false);
  });
});

describe("attr role skip", () => {
  test("values and numeric MVs skip lookup/ignore keys", () => {
    expect(attrValueMvWhereSql).toContain(attrRoleSkipSql);
    expect(attrNumericMvWhereSql).toContain(attrRoleSkipSql);
    expect(attrRoleSkipSql).toContain("field_role_skip");
  });
});

describe("message text index", () => {
  test("indexes lowerUTF8(message) as TYPE text", () => {
    expect(messageTextIndexSql).toContain("lowerUTF8(message)");
    expect(messageTextIndexSql).toContain("TYPE text");
    expect(messageTextIndexSql).toContain("splitByNonAlpha");
  });
});

describe("ensure logs", () => {
  test("create SQL matches clickhouse/init.sql", async () => {
    const init = await Bun.file(
      `${import.meta.dir}/../../clickhouse/init.sql`,
    ).text();
    expect(logsCreateTableSql).toContain("CREATE TABLE IF NOT EXISTS logs");
    expect(logsCreateTableSql).toContain("ORDER BY (tenant_id, service, ts)");
    expect(init).toContain("CREATE TABLE IF NOT EXISTS logs");
    expect(init).toContain("attr_map Map(LowCardinality(String), String)");
  });
});

describe("ClickHouse version", () => {
  test("old-server boot guidance uses the packaged stack and preserves data", async () => {
    const previousFetch = globalThis.fetch;
    const previousDev = process.env.TOPOSCOPE_DEV;
    delete process.env.TOPOSCOPE_DEV;
    globalThis.fetch = Object.assign(
      async () => Response.json({ data: [{ v: "24.8.14.39" }] }),
      { preconnect: previousFetch.preconnect },
    );
    let message = "";
    try {
      await requireClickHouseVersion();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousDev === undefined) delete process.env.TOPOSCOPE_DEV;
      else process.env.TOPOSCOPE_DEV = previousDev;
    }
    expect(message).toContain("compose.yml");
    expect(message).not.toContain("compose.dev.yml");
    expect(message).not.toMatch(/remove.*volume/i);
    expect(message).toMatch(/restore|backup/i);
  });

  test("parses official build strings and requires 26.3", () => {
    expect(parseClickHouseVersion("24.8.14.39 (official build)")).toEqual([
      24, 8, 14, 39,
    ]);
    expect(clickhouseVersionAtLeast("24.8.14.39", "26.3")).toBe(false);
    expect(clickhouseVersionAtLeast("26.2.1.1", "26.3")).toBe(false);
    expect(clickhouseVersionAtLeast("26.3.1.1", "26.3")).toBe(true);
    expect(clickhouseVersionAtLeast("26.4.0", "26.3")).toBe(true);
  });
});

describe("clampRetentionDays", () => {
  test("defaults and clamps", () => {
    expect(clampRetentionDays(Number.NaN)).toBe(30);
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(400)).toBe(365);
  });
});

describe("clampMetricsRetentionDays", () => {
  test("allows more than logs, up to 730", () => {
    expect(clampMetricsRetentionDays(Number.NaN)).toBe(30);
    expect(clampMetricsRetentionDays(0)).toBe(1);
    expect(clampMetricsRetentionDays(400)).toBe(400);
    expect(clampMetricsRetentionDays(800)).toBe(730);
  });
});

describe("retention TTL ALTER", () => {
  test("covers every retained table and does not wait for mutations", () => {
    expect(retentionTtlTables.map((spec) => spec.table)).toEqual([
      "logs",
      "logs_by_minute",
      "logs_attr_keys_by_minute",
      "logs_attr_values_by_minute",
      "logs_attr_numeric_by_minute",
      "metrics",
      "metrics_by_minute",
      "metric_buckets",
      "metric_buckets_by_minute",
      "spans",
      "profile_samples",
      "change_marks",
      "monitor_results",
    ]);
    expect(retentionTtlAlterSettings).toContain("mutations_sync = 0");
    expect(retentionTtlAlterSettings).toContain("alter_sync = 0");
    expect(killUnfinishedTtlMutationSql).toContain("KILL MUTATION");
    expect(killUnfinishedTtlMutationSql).toContain("TTL");
  });

  test("metrics and their rollups are the metric tables", () => {
    expect(retentionTtlTables.map((spec) => spec.table).filter(isMetricsRetentionTable)).toEqual([
      "metrics",
      "metrics_by_minute",
      "metric_buckets",
      "metric_buckets_by_minute",
    ]);
  });

  test("a metric table clamps to the metrics range", () => {
    expect(retentionTtlAlterSql("metrics", "ts", 400)).toBe(
      "ALTER TABLE metrics MODIFY TTL toDate(ts) + INTERVAL 400 DAY SETTINGS mutations_sync = 0, alter_sync = 0",
    );
    expect(retentionTtlAlterSql("metric_buckets_by_minute", "minute", 800)).toContain("INTERVAL 730 DAY");
    expect(retentionTtlAlterSql("spans", "ts", 400)).toContain("INTERVAL 365 DAY");
  });

  test("uses toDate(ts) or toDate(minute) and clamps days", () => {
    expect(retentionTtlAlterSql("logs", "ts", 365)).toBe(
      "ALTER TABLE logs MODIFY TTL toDate(ts) + INTERVAL 365 DAY SETTINGS mutations_sync = 0, alter_sync = 0",
    );
    expect(retentionTtlAlterSql("logs_by_minute", "minute", 400)).toBe(
      "ALTER TABLE logs_by_minute MODIFY TTL toDate(minute) + INTERVAL 365 DAY SETTINGS mutations_sync = 0, alter_sync = 0",
    );
  });

  test("reads ClickHouse engine_full TTL days", () => {
    expect(
      parseTtlIntervalDays(
        "MergeTree PARTITION BY toDate(ts) TTL toDate(ts) + toIntervalDay(365)",
      ),
    ).toBe(365);
    expect(parseTtlIntervalDays("TTL toDate(ts) + INTERVAL 30 DAY")).toBe(30);
    expect(parseTtlIntervalDays("MergeTree ORDER BY ts")).toBeNull();
  });
});

describe("retention by service (#477)", () => {
  const rules = [
    { service: "billing", days: 90 },
    { service: "analytics", days: 730 },
  ];

  test("logs, their rollups and spans keep a service longer; nothing else does", () => {
    expect(retentionTtlTables.map((spec) => spec.table).filter(isServiceRetentionTable)).toEqual([
      "logs",
      "logs_by_minute",
      "logs_attr_keys_by_minute",
      "logs_attr_values_by_minute",
      "logs_attr_numeric_by_minute",
      "spans",
    ]);
  });

  test("with no rules the TTL is today's, so an install that sets none sees no ALTER", () => {
    expect(retentionTtlExpr("logs", "ts", 30)).toBe("toDate(ts) + INTERVAL 30 DAY");
    expect(retentionTtlExpr("logs", "ts", 30, [])).toBe("toDate(ts) + INTERVAL 30 DAY");
  });

  test("rules become one transform over service, sorted, with logs' days as the default", () => {
    expect(retentionTtlExpr("logs", "ts", 30, rules)).toBe(
      "addDays(toDate(ts), transform(service, ['analytics', 'billing'], [730, 90], 30))",
    );
    expect(retentionTtlExpr("logs_by_minute", "minute", 30, rules)).toBe(
      "addDays(toDate(minute), transform(service, ['analytics', 'billing'], [730, 90], 30))",
    );
    expect(retentionTtlAlterSql("spans", "ts", 30, rules)).toBe(
      "ALTER TABLE spans MODIFY TTL addDays(toDate(ts), transform(service, ['analytics', 'billing'], [730, 90], 30)) SETTINGS mutations_sync = 0, alter_sync = 0",
    );
  });

  test("tables without service ignore the rules", () => {
    expect(retentionTtlExpr("metrics", "ts", 400, rules)).toBe("toDate(ts) + INTERVAL 400 DAY");
    expect(retentionTtlExpr("profile_samples", "ts", 30, rules)).toBe("toDate(ts) + INTERVAL 30 DAY");
    expect(retentionTtlExpr("change_marks", "ts", 30, rules)).toBe("toDate(ts) + INTERVAL 30 DAY");
  });

  test("a rule never keeps fewer days than logs, and never past 730", () => {
    expect(retentionTtlExpr("logs", "ts", 60, [{ service: "a", days: 10 }])).toContain("[60], 60)");
    expect(retentionTtlExpr("logs", "ts", 30, [{ service: "a", days: 9000 }])).toContain("[730], 30)");
  });

  test("a service name is quoted as ClickHouse prints it back", () => {
    expect(clickhouseStringLiteral("it's")).toBe("'it\\'s'");
    expect(clickhouseStringLiteral("a\\b")).toBe("'a\\\\b'");
  });

  test("an engine already on the asked TTL needs no ALTER", () => {
    const plain = "MergeTree PARTITION BY toDate(ts) TTL toDate(ts) + toIntervalDay(30) SETTINGS index_granularity = 8192";
    expect(ttlMatches(plain, "toDate(ts) + INTERVAL 30 DAY")).toBe(true);
    expect(ttlMatches(plain, "toDate(ts) + INTERVAL 31 DAY")).toBe(false);
    const expr = retentionTtlExpr("logs", "ts", 30, rules);
    const kept = `MergeTree PARTITION BY toDate(ts) ORDER BY (tenant_id, service, ts) TTL ${expr} SETTINGS index_granularity = 8192`;
    expect(ttlMatches(kept, expr)).toBe(true);
    expect(ttlMatches(kept, "toDate(ts) + INTERVAL 30 DAY")).toBe(false);
    expect(ttlMatches(kept, retentionTtlExpr("logs", "ts", 30, [{ service: "analytics", days: 730 }]))).toBe(false);
    expect(ttlMatches("", "toDate(ts) + INTERVAL 30 DAY")).toBe(false);
  });
});
