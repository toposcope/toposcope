import { describe, expect, test } from "bun:test";
import {
  attrNumericMvWhereSql,
  attrRoleSkipSql,
  attrValueMvWhereSql,
  clampRetentionDays,
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
      "spans",
      "profile_samples",
      "change_marks",
    ]);
    expect(retentionTtlAlterSettings).toContain("mutations_sync = 0");
    expect(retentionTtlAlterSettings).toContain("alter_sync = 0");
    expect(killUnfinishedTtlMutationSql).toContain("KILL MUTATION");
    expect(killUnfinishedTtlMutationSql).toContain("TTL");
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
