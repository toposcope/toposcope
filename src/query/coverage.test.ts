import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseCommand } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { coverageSql, readCoverage } from "./coverage";

process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
process.env.CLICKHOUSE_USER ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "toposcope";

const tag = Date.now().toString(36);
const api = `cov${tag}`;
const worker = `wrk${tag}`;
const now = Date.now();
const ts = (ago: number) => new Date(now - ago).toISOString().slice(0, 23).replace("T", " ");

describe("GET /api/coverage (#391)", () => {
  test("never reads logs", () => {
    for (const sql of Object.values(coverageSql)) {
      expect(sql).not.toMatch(/FROM logs\b(?!_)/);
    }
  });

  describe("with rows", () => {
    beforeAll(async () => {
      await migrateStore();
      const rows: string[] = [];
      // api: 10 rows, all with version 1.4.2 and a host, 9 with trace_id; 2 errors, both with a stack
      for (let i = 0; i < 10; i++) {
        const err = i < 2;
        const attrs = [`'version', '1.4.2'`, ...(i < 9 ? [`'trace_id', '${"a".repeat(31)}${i}'`] : []), ...(err ? [`'exception.stacktrace', 'at x'`, `'exception.frames', '[]'`] : [])];
        rows.push(`('${ts(60_000 * (i + 1))}', '${api}', 'h1', '${err ? "error" : "info"}', 'm', map(${attrs.join(", ")}))`);
      }
      // worker: 4 rows, no version, no host; 4 errors, 1 with a stack
      for (let i = 0; i < 4; i++) {
        rows.push(`('${ts(60_000 * (i + 1))}', '${worker}', '', 'error', 'boom', map(${i === 0 ? "'exception.frames', '[]'" : ""}))`);
      }
      await clickhouseCommand(`INSERT INTO logs (ts, service, host, level, message, attr_map) VALUES ${rows.join(", ")}`);
      await clickhouseCommand(
        `INSERT INTO spans (tenant_id, trace_id, span_id, parent_span_id, service, name, ts, duration_ms, status, attrs) VALUES ('default', '${"b".repeat(32)}', '${"c".repeat(16)}', '', '${api}', 'GET', '${ts(60_000)}', 1, 'ok', map()), ('default', '${"b".repeat(32)}', '${"d".repeat(16)}', '', '${api}-svc', 'GET', '${ts(60_000)}', 1, 'ok', map())`,
      );
      await clickhouseCommand(
        `INSERT INTO change_marks (tenant_id, ts, kind, service, title, attrs, id) VALUES ('default', '${ts(30 * 60_000)}', 'deploy', '${api}', 'deployed v1.4.2', map('version', 'v1.4.2'), 'deploy-${api}-v1.4.2')`,
      );
    });

    test("shares from the rollups, a mark, and both kinds of mismatch", async () => {
      const c = await readCoverage();
      const a = c.services.find((s) => s.service === api)!;
      expect(a.rows).toBe(10);
      expect(a.version).toBe(1);
      expect(a.host).toBe(1);
      expect(a.trace_id).toBeCloseTo(0.9);
      // a row with both a stacktrace and frames counts once
      expect(a.stack).toBe(1);
      expect(a.marks.count).toBe(1);
      expect(a.complete).toBe(true);

      const w = c.services.find((s) => s.service === worker)!;
      expect(w.version).toBe(0);
      expect(w.host).toBe(0);
      expect(w.trace_id).toBeNull();
      expect(w.stack).toBe(0.25);
      expect(w.complete).toBe(false);

      expect(c.mismatches).toContainEqual(expect.objectContaining({ kind: "service", service: api, other: `${api}-svc`, spans: 1 }));
      expect(c.mismatches).toContainEqual(
        expect.objectContaining({ kind: "version", service: api, rows_value: "1.4.2", mark_value: "v1.4.2", mark_id: `deploy-${api}-v1.4.2` }),
      );
    });
  });
});
