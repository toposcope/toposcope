import { describe, expect, test } from "bun:test";
import {
  clickhouseCommand,
  clickhouseInsertJsonEachRow,
  pingClickHouse,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { logsCreateTableSql } from "../shared/migrate";
import { parseChangeMark } from "../shared/change-mark";
import { fingerprintCutScans, searchFingerprintCut } from "./fingerprint-cut";
import { getChangeMarkById, searchChangeMarks } from "./marks";

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

  test(
    "opens a mark whose stored id is empty via the fallback id the list returns",
    async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
      if (!(await pingClickHouse())) {
        return;
      }
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
      const title = `emptyid${Date.now()}`;
      const ts = "2026-08-20T12:00:00.000Z";
      await clickhouseInsertJsonEachRow(
        JSON.stringify({
          tenant_id: "default",
          ts: toClickHouseDateTime(ts),
          kind: "deploy",
          service: "billing",
          title,
          attrs: {},
          id: "",
          end_ts: null,
        }),
        "change_marks",
      );
      const from = "2026-08-20T00:00:00.000Z";
      const to = "2026-08-20T23:59:59.000Z";
      let listed = (await searchChangeMarks({ from, to })).marks.find(
        (mark) => mark.title === title,
      );
      for (let i = 0; i < 20 && !listed; i++) {
        await Bun.sleep(50);
        listed = (await searchChangeMarks({ from, to })).marks.find(
          (mark) => mark.title === title,
        );
      }
      expect(listed?.id).toBeTruthy();
      expect(listed!.id).not.toBe("");
      const found = await getChangeMarkById(listed!.id);
      expect(found?.title).toBe(title);
    },
    { timeout: 15_000 },
  );

  test(
    "keeps first seen / still here / stopped when the sample logs scan hits the row budget",
    async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
      if (!(await pingClickHouse())) {
        return;
      }
      await clickhouseCommand(logsCreateTableSql);
      const token = `cutbudget${Date.now()}`;
      const markTs = Date.parse("2026-08-14T16:00:00.000Z");
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
      const log = (ms: number, hex: string, message: string) =>
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
          log(markTs - 60_000, "dddddddddddddddd", `${token} stopped`),
          log(markTs + 60_000, "eeeeeeeeeeeeeeee", `${token} first`),
        ].join("\n"),
      );
      const prevSamples = fingerprintCutScans.samples;
      fingerprintCutScans.samples = async () => {
        throw new Error(
          "Limit for rows (controlled by 'max_rows_to_read') exceeded: 20000000",
        );
      };
      try {
        let result = await searchFingerprintCut({
          mark,
          from: iso(openedAt - 60 * 60_000),
          to: iso(openedAt),
          opened: iso(openedAt),
          q: token,
        });
        for (let i = 0; i < 20 && result.sets.every((s) => s.count === 0) && !result.scan; i++) {
          await Bun.sleep(50);
          result = await searchFingerprintCut({
            mark,
            from: iso(openedAt - 60 * 60_000),
            to: iso(openedAt),
            opened: iso(openedAt),
            q: token,
          });
        }
        expect(result.empty).toBe("");
        expect(result.scan).toBeUndefined();
        const hexes = (id: "first_seen" | "still_here" | "stopped") =>
          result.sets.find((s) => s.id === id)?.rows.map((r) => r.hex) ?? [];
        expect(hexes("first_seen")).toContain("eeeeeeeeeeeeeeee");
        expect(hexes("stopped")).toContain("dddddddddddddddd");
      } finally {
        fingerprintCutScans.samples = prevSamples;
      }
    },
    { timeout: 15_000 },
  );
});
