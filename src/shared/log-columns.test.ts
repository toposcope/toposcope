import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseQuery, pingClickHouse } from "./clickhouse";
import { codecMatches, columnCodecs, migrateStore } from "./migrate";
import { insertEvents } from "../ingest/index";
import { search } from "../query/index";

describe("log columns", () => {
  test("a codec matches ClickHouse's own spelling of it", () => {
    expect(codecMatches("CODEC(DoubleDelta, ZSTD(1))", "DoubleDelta, ZSTD(1)")).toBe(true);
    expect(codecMatches("CODEC(ZSTD(1))", "ZSTD(1)")).toBe(true);
    expect(codecMatches("", "ZSTD(1)")).toBe(false);
    expect(codecMatches("CODEC(LZ4)", "ZSTD(1)")).toBe(false);
  });

  describe("on ClickHouse", () => {
    beforeAll(async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      if (!(await pingClickHouse())) throw new Error("ClickHouse is required for column codecs");
      await migrateStore();
    });

    test("every listed column has its codec after a start, and a second start changes nothing", async () => {
      await migrateStore();
      for (const [table, columns] of Object.entries(columnCodecs)) {
        const rows = await clickhouseQuery<{ name: string; compression_codec: string }>(
          `SELECT name, compression_codec FROM system.columns
           WHERE database = currentDatabase() AND table = {table:String}`,
          { table },
        );
        for (const [column, codec] of Object.entries(columns)) {
          const row = rows.find((r) => r.name === column);
          expect(row, `${table}.${column}`).toBeDefined();
          expect(codecMatches(row?.compression_codec ?? "", codec), `${table}.${column}`).toBe(true);
        }
      }
    });

    test("changing a codec starts no mutation", async () => {
      const rows = await clickhouseQuery<{ n: string }>(
        `SELECT count() AS n FROM system.mutations
         WHERE database = currentDatabase() AND command LIKE '%CODEC%'`,
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
    });

    test("a row keeps its attributes in attr_map only, and reads back whole", async () => {
      const service = `attrsonly${Date.now()}`;
      const ts = new Date(Date.now() - 60_000).toISOString();
      await insertEvents([{ ts, service, level: "info", message: "one", attrs: { status: "502", "http.path": "/a\"b", n: 3 } }]);
      const stored = await clickhouseQuery<{ attrs: string; status: string }>(
        `SELECT attrs, attr_map['status'] AS status FROM logs WHERE service = {service:String}`,
        { service },
      );
      expect(stored).toEqual([{ attrs: "{}", status: "502" }]);
      const result = await search({
        q: `service:${service} status:502`,
        from: new Date(Date.parse(ts) - 60_000).toISOString(),
        to: new Date(Date.parse(ts) + 60_000).toISOString(),
        limit: 5,
      });
      expect(result.events.map((e) => e.attrs)).toEqual([{ status: "502", "http.path": '/a"b', n: "3" }]);
    });
  });
});
