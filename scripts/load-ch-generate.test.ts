import { describe, expect, test } from "bun:test";
import { fakeLogEvent, mix32 } from "../src/shared/fake-event";
import {
  ensureClickHouseEnv,
  fakeLogsSelectSql,
  mix32SelectSql,
} from "./load-ch-generate";
import { clickhouseQuery, pingClickHouse } from "../src/shared/clickhouse";

describe("fakeLogsSelectSql", () => {
  test("generates a numbers() select with attr_map", () => {
    const sql = fakeLogsSelectSql(0, 1000, {
      n: 100_000_000,
      nowMs: 1,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      marker: "load-100m-1",
    });
    expect(sql).toContain("FROM numbers(0, 1000)");
    expect(sql).toContain("AS attr_map");
    expect(sql).toContain("load-100m-1");
    expect(sql).toContain("73");
    expect(sql).not.toContain("203.0.113");
  });
});

describe("mix32 ClickHouse", () => {
  test("matches JS mix32 when ClickHouse is up", async () => {
    ensureClickHouseEnv();
    if (!(await pingClickHouse())) {
      return;
    }
    const cases: Array<[number, number]> = [
      [0, 1],
      [42, 1],
      [1_000_000_000, 91],
    ];
    for (const [i, salt] of cases) {
      const rows = await clickhouseQuery<{ mix: string | number }>(
        mix32SelectSql(i, salt),
      );
      expect(Number(rows[0]?.mix)).toBe(mix32(i, salt));
    }
  });

  test("one generated row matches fakeLogEvent when ClickHouse is up", async () => {
    ensureClickHouseEnv();
    if (!(await pingClickHouse())) {
      return;
    }
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const n = 1_000_000;
    const i = 42;
    const marker = "load-100m-test";
    const expected = fakeLogEvent({ i, n, now, windowMs, marker });
    const sql = `SELECT
      service,
      host,
      level,
      message,
      attr_map['path'] AS path,
      attr_map['status'] AS status,
      attr_map['duration_ms'] AS duration_ms,
      attr_map['request_id'] AS request_id,
      attr_map['user_id'] AS user_id,
      attr_map['client_ip'] AS client_ip
    FROM (${fakeLogsSelectSql(i, 1, { n, nowMs: now, windowMs, marker })})`;
    const rows = await clickhouseQuery<{
      service: string;
      host: string;
      level: string;
      message: string;
      path: string;
      status: string | number;
      duration_ms: string | number;
      request_id: string;
      user_id: string;
      client_ip: string;
    }>(sql);
    const row = rows[0];
    expect(row?.service).toBe(expected.service);
    expect(row?.host).toBe(expected.host);
    expect(row?.level).toBe(expected.level);
    expect(row?.message).toBe(expected.message);
    expect(row?.path).toBe(String(expected.attrs.path));
    expect(Number(row?.status)).toBe(Number(expected.attrs.status));
    expect(Number(row?.duration_ms)).toBe(Number(expected.attrs.duration_ms));
    expect(row?.request_id).toBe(String(expected.attrs.request_id));
    expect(row?.client_ip).toBe(String(expected.attrs.client_ip));
    const expectedUser =
      expected.attrs.user_id === undefined
        ? undefined
        : String(expected.attrs.user_id);
    expect(row?.user_id ? row.user_id : undefined).toBe(expectedUser);
  });
});
