import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseQuery, pingClickHouse } from "./clickhouse";
import { codecMatches, columnCodecs, migrateStore } from "./migrate";

describe("column codecs", () => {
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
  });
});
