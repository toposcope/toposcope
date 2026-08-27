import { describe, expect, test } from "bun:test";
import {
  clickhouseCommand,
  clickhouseInsertJsonEachRow,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { logsCreateTableSql } from "../shared/migrate";
import {
  aroundSearchParams,
  aroundWhere,
  assembleSurroundingSides,
  clampSurroundingN,
  searchAroundTs,
  surroundingAfterTsSql,
  surroundingBeforeTsSql,
  surroundingDefaultN,
  surroundingMaxN,
  surroundingWhere,
} from "./surrounding";

describe("clampSurroundingN", () => {
  test("defaults to 50 and caps at 200", () => {
    expect(clampSurroundingN(undefined)).toBe(surroundingDefaultN);
    expect(clampSurroundingN(0)).toBe(1);
    expect(clampSurroundingN(500)).toBe(surroundingMaxN);
    expect(clampSurroundingN(25)).toBe(25);
  });
});

describe("surroundingWhere", () => {
  test("pivots on service and host without a query", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      host: "api-1",
    });
    expect(sql).toContain("service = {service:String}");
    expect(sql).toContain("host = {host:String}");
    expect(sql).not.toContain("level =");
    expect(params.service).toBe("api");
    expect(params.host).toBe("api-1");
  });

  test("Matching ANDs the search bar onto the pivot", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: "level:error timeout status:503",
    });
    expect(sql).toContain("level = {qp0:String}");
    expect(sql).toContain("hasToken(lowerUTF8(message), {qp1:String})");
    expect(sql).not.toContain("hasPhrase");
    expect(sql).toContain("attr_map[{qp3:String}] = {qp2:String}");
    expect(params.qp0).toBe("error");
    expect(params.qp1).toBe("timeout");
    expect(params.qp2).toBe("503");
    expect(params.qp3).toBe("status");
  });

  test("Matching consecutive phrase uses hasSubstr, not hasPhrase", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: '"deadline exceeded"',
    });
    expect(sql).toContain("hasSubstr(splitByNonAlpha(lowerUTF8(message))");
    expect(sql).not.toContain("hasPhrase");
    expect(sql).not.toContain("hasAllTokens");
    expect(params.qp0).toBe("deadline");
    expect(params.qp1).toBe("exceeded");
  });

  test("Matching ANDs a numeric comparison onto the pivot", () => {
    const { sql, params } = surroundingWhere({
      ts: "2026-08-14T15:00:00.000Z",
      service: "api",
      q: "duration_ms:>40",
    });
    expect(sql).toContain(
      "ifNull(toFloat64OrNull(attr_map[{qp0:String}]) > {qp1:Float64}, 0)",
    );
    expect(params.qp0).toBe("duration_ms");
    expect(params.qp1).toBe("40");
  });
});

describe("aroundWhere", () => {
  test("does not pivot on service and keeps the hunt window", () => {
    const { sql, params } = aroundWhere({
      ts: "2026-08-25T16:32:14.000Z",
      from: "2026-08-25T16:25:00.000Z",
      to: "2026-08-25T16:40:00.000Z",
      q: "level:error",
    });
    expect(sql).not.toContain("service =");
    expect(sql).not.toContain("host =");
    expect(sql).toContain("ts >= parseDateTime64BestEffort({from:String})");
    expect(sql).toContain("ts <= parseDateTime64BestEffort({to:String})");
    expect(sql).toContain("level = {qp0:String}");
    expect(params.from).toBe("2026-08-25T16:25:00.000Z");
    expect(params.to).toBe("2026-08-25T16:40:00.000Z");
    expect(params.qp0).toBe("error");
  });

  test("without q is the hunt window only — exclusive ts lives on each side query", () => {
    const { sql, params } = aroundWhere({
      ts: "2026-08-25T16:29:37.732Z",
      from: "2026-08-25T16:25:00.000Z",
      to: "2026-08-25T16:40:00.000Z",
    });
    expect(sql).toBe(
      "tenant_id = {tenant_id:String} AND ts >= parseDateTime64BestEffort({from:String}) AND ts <= parseDateTime64BestEffort({to:String})",
    );
    expect(sql).not.toContain("ts < parseDateTime64BestEffort({ts:String})");
    expect(sql).not.toContain("ts > parseDateTime64BestEffort({ts:String})");
    expect(params.ts).toBe("2026-08-25T16:29:37.732Z");
    expect(params).not.toHaveProperty("qp0");
  });
});

describe("aroundSearchParams", () => {
  test("asks for n each side of ts inside the hunt window", () => {
    const params = aroundSearchParams({
      ts: "2026-08-25T16:29:37.732Z",
      from: "2026-08-25T16:25:00.000Z",
      to: "2026-08-25T16:40:00.000Z",
      q: "level:error",
      n: 50,
    });
    expect(params.get("ts")).toBe("2026-08-25T16:29:37.732Z");
    expect(params.get("n")).toBe("50");
    expect(params.get("from")).toBe("2026-08-25T16:25:00.000Z");
    expect(params.get("to")).toBe("2026-08-25T16:40:00.000Z");
    expect(params.get("q")).toBe("level:error");
    expect(params.has("service")).toBe(false);
    expect(params.has("host")).toBe(false);
  });

  test("Focus in logs All analog omits q and defaults n to 50", () => {
    const params = aroundSearchParams({
      ts: "2026-08-25T16:29:37.732Z",
      from: "2026-08-25T16:25:00.000Z",
      to: "2026-08-25T16:40:00.000Z",
    });
    expect(params.get("n")).toBe(String(surroundingDefaultN));
    expect(params.has("q")).toBe(false);
    expect(aroundSearchParams({ ts: "2026-08-25T16:29:37.732Z", q: "  " }).has("q")).toBe(
      false,
    );
  });

  test("clamps n to 200", () => {
    expect(
      aroundSearchParams({ ts: "2026-08-25T16:29:37.732Z", n: 500 }).get("n"),
    ).toBe(String(surroundingMaxN));
  });
});

describe("assembleSurroundingSides", () => {
  test("paints older above and closer-newer below, exclusive of the pivot", () => {
    expect(surroundingBeforeTsSql).toBe(
      "ts < parseDateTime64BestEffort({ts:String})",
    );
    expect(surroundingAfterTsSql).toBe(
      "ts > parseDateTime64BestEffort({ts:String})",
    );
    const sides = assembleSurroundingSides(
      ["16:29:36", "16:29:35", "16:29:34"],
      ["16:29:38", "16:29:39"],
    );
    expect(sides.before).toEqual(["16:29:34", "16:29:35", "16:29:36"]);
    expect(sides.after).toEqual(["16:29:38", "16:29:39"]);
    expect(sides.before).not.toContain("16:29:37");
    expect(sides.after).not.toContain("16:29:37");
  });
});

describe("searchAroundTs ClickHouse", () => {
  test(
    "returns n each side, oldest-first before, exclusive of the pivot ts",
    async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
      if (!(await pingClickHouse())) {
        return;
      }
      await clickhouseCommand(logsCreateTableSql);
      const token = `around${Date.now()}`;
      const pivotMs = Date.parse("2026-08-25T16:29:37.732Z");
      const iso = (ms: number) => new Date(ms).toISOString();
      const services = ["billing", "api", "worker"] as const;
      const rows: Array<{
        ts: number;
        service: string;
        message: string;
      }> = [];
      for (let i = 5; i >= 1; i--) {
        rows.push({
          ts: pivotMs - i,
          service: services[i % 3]!,
          message: `${token} before${i}`,
        });
      }
      rows.push({
        ts: pivotMs,
        service: "worker",
        message: `${token} same`,
      });
      for (let i = 1; i <= 5; i++) {
        rows.push({
          ts: pivotMs + i,
          service: services[i % 3]!,
          message: `${token} after${i}`,
        });
      }
      rows.push({
        ts: pivotMs - 1000,
        service: "nginx",
        message: `${token} outside-before`,
      });
      rows.push({
        ts: pivotMs + 1000,
        service: "nginx",
        message: `${token} outside-after`,
      });
      const body = rows
        .map((row) =>
          JSON.stringify({
            tenant_id: "default",
            ts: toClickHouseDateTime(iso(row.ts)),
            service: row.service,
            host: "",
            level: "info",
            message: row.message,
            attrs: "{}",
            attr_map: {},
            trace_id: "",
          }),
        )
        .join("\n");
      await clickhouseInsertJsonEachRow(body);
      const from = iso(pivotMs - 10);
      const to = iso(pivotMs + 10);
      let sides = await searchAroundTs({
        ts: iso(pivotMs),
        from,
        to,
        n: 3,
        q: token,
      });
      for (let i = 0; i < 20 && sides.before.length < 3; i++) {
        await Bun.sleep(50);
        sides = await searchAroundTs({
          ts: iso(pivotMs),
          from,
          to,
          n: 3,
          q: token,
        });
      }
      expect(sides.before.map((row) => row.message)).toEqual([
        `${token} before3`,
        `${token} before2`,
        `${token} before1`,
      ]);
      expect(sides.after.map((row) => row.message)).toEqual([
        `${token} after1`,
        `${token} after2`,
        `${token} after3`,
      ]);
      expect(sides.before.some((row) => row.message.endsWith(" same"))).toBe(
        false,
      );
      expect(sides.after.some((row) => row.message.endsWith(" same"))).toBe(
        false,
      );
      expect(
        sides.before.concat(sides.after).some((row) =>
          row.message.includes("outside"),
        ),
      ).toBe(false);
      expect(new Set(sides.before.map((row) => row.service)).size).toBeGreaterThan(
        1,
      );
    },
    { timeout: 20_000 },
  );
});
