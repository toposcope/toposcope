import { describe, expect, test } from "bun:test";
import {
  clickhouseCommand,
  clickhouseInsertJsonEachRow,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { logsCreateTableSql } from "../shared/migrate";
import { parseChangeMark } from "../shared/change-mark";
import { searchFingerprintCut } from "./fingerprint-cut";
import { getChangeMarkById } from "./marks";

describe("searchFingerprintCut ClickHouse", () => {
  test(
    "classifies first seen, still here, and stopped for the hunt q",
    async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
      if (!(await pingClickHouse())) {
        return;
      }
      await clickhouseCommand(logsCreateTableSql);
      await clickhouseCommand(`
        CREATE TABLE IF NOT EXISTS change_marks (
          tenant_id LowCardinality(String),
          ts DateTime64(3, 'UTC'),
          kind LowCardinality(String),
          service LowCardinality(String),
          title String,
          attrs Map(LowCardinality(String), String),
          id String DEFAULT '',
          end_ts Nullable(DateTime64(3, 'UTC'))
        )
        ENGINE = MergeTree
        PARTITION BY toDate(ts)
        ORDER BY (tenant_id, ts, kind)
        TTL toDate(ts) + INTERVAL 30 DAY
      `);
      const token = `cut${Date.now()}`;
      const markTs = Date.parse("2026-08-14T14:30:00.000Z");
      const openedAt = markTs + 5 * 60_000;
      const iso = (ms: number) => new Date(ms).toISOString();
      const mark = parseChangeMark({
        kind: "deploy",
        title: token,
        service: "worker",
        ts: iso(markTs),
        id: `mk_${token.slice(-12)}`,
      });
      await clickhouseInsertJsonEachRow(
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(mark.ts),
          kind: mark.kind,
          service: mark.service,
          title: mark.title,
          attrs: mark.attrs,
          id: mark.id,
          end_ts: null,
        }),
        "change_marks",
      );
      const log = (
        ms: number,
        hex: string,
        message: string,
      ) =>
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(iso(ms)),
          service: "worker",
          host: "worker-1",
          level: "error",
          message,
          attrs: JSON.stringify({ e1: hex }),
          attr_map: { e1: hex },
          trace_id: "",
        });
      await clickhouseInsertJsonEachRow(
        [
          log(markTs - 60_000, "aaaaaaaaaaaaaaaa", `${token} stopped`),
          log(markTs - 60_000, "bbbbbbbbbbbbbbbb", `${token} still`),
          log(markTs + 60_000, "bbbbbbbbbbbbbbbb", `${token} still`),
          log(markTs + 60_000, "cccccccccccccccc", `${token} first`),
        ].join("\n"),
      );
      let stored = await getChangeMarkById(mark.id);
      for (let i = 0; i < 20 && !stored; i++) {
        await Bun.sleep(50);
        stored = await getChangeMarkById(mark.id);
      }
      expect(stored?.id).toBe(mark.id);
      let result = await searchFingerprintCut({
        mark: stored!,
        from: iso(openedAt - 60 * 60_000),
        to: iso(openedAt),
        opened: iso(openedAt),
        q: token,
      });
      const firstHex = () =>
        result.sets
          .find((s) => s.id === "first_seen")
          ?.rows.map((r) => r.hex)
          .sort()
          .join(",");
      for (let i = 0; i < 20 && !firstHex()?.includes("cc"); i++) {
        await Bun.sleep(50);
        result = await searchFingerprintCut({
          mark: stored!,
          from: iso(openedAt - 60 * 60_000),
          to: iso(openedAt),
          opened: iso(openedAt),
          q: token,
        });
      }
      const hexes = (id: "first_seen" | "still_here" | "stopped") =>
        result.sets.find((s) => s.id === id)?.rows.map((r) => r.hex) ?? [];
      expect(hexes("first_seen")).toContain("cccccccccccccccc");
      expect(hexes("still_here")).toContain("bbbbbbbbbbbbbbbb");
      expect(hexes("stopped")).toContain("aaaaaaaaaaaaaaaa");
      expect(result.empty).toBe("");
      expect(result.windows.dead).toBe(false);
    },
    { timeout: 15_000 },
  );
});
