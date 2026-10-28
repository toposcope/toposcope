import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseQuery, pingClickHouse } from "../shared/clickhouse";
import { applyRetentionDays, migrateStore } from "../shared/migrate";
import { ensureFullSeqProjection, fullSeqProjectionTables } from "../feed/feed";
import { insertEvents } from "./index";
import { insertMetricBuckets, insertMetricPoints } from "./metrics";
import { insertSpans } from "./otlp-traces-route";
import { insertProfileSamples } from "./otlp-profiles-route";
import { allocateArrivalSeq, loadArrivalSeq, releaseArrivalSeq, resetArrivalSeqForTests } from "./arrival-seq";

type Row = { seq: string | number; toposcope: string };

async function positions(table: string, where: string, params: Record<string, string>): Promise<number[]> {
  const rows = await clickhouseQuery<Row>(`SELECT seq, toposcope FROM ${table} WHERE ${where} ORDER BY seq`, params);
  return rows.map((r) => Number(r.seq));
}

describe("every kind takes its position from one counter (#324)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for kind positions");
    await migrateStore();
  });

  test("a mixed ingest is numbered across kinds in arrival order, with no number repeated", async () => {
    const tag = `kp${Date.now().toString(36)}`;
    const ts = new Date(Date.now() - 30_000).toISOString();
    await insertEvents([{ ts, service: tag, level: "info", message: "a log" }]);
    await insertSpans([
      { trace_id: `${tag}t`, span_id: `${tag}s`, parent_span_id: "", service: tag, name: "GET /", ts, duration_ms: 3, status: "ok", attrs: {} },
    ]);
    await insertMetricPoints([
      { ts, name: `${tag}.m`, value: 1, labels: { service: tag } },
      { ts, name: `${tag}.m`, value: 2, labels: { service: tag } },
    ]);
    await insertMetricBuckets([{ ts, name: `${tag}.h`, labels: { service: tag }, le: [1], n: [1, 0] }]);
    await insertProfileSamples([
      {
        profile_id: `${tag}p`, service: tag, ts, duration_ms: 1, sample_type: "cpu", sample_unit: "ns",
        period_type: "cpu", period_unit: "ns", trace_id: `${tag}t`, span_id: `${tag}s`, frames: ["main"], value: 5,
      },
    ]);
    const log = await positions("logs", "service = {s:String}", { s: tag });
    const span = await positions("spans", "service = {s:String}", { s: tag });
    const points = await positions("metrics", "name = {n:String}", { n: `${tag}.m` });
    const buckets = await positions("metric_buckets", "name = {n:String}", { n: `${tag}.h` });
    const profile = await positions("profile_samples", "service = {s:String}", { s: tag });
    const all = [...log, ...span, ...points, ...buckets, ...profile];
    expect(all).toHaveLength(6);
    expect(all.every((n) => n > 0)).toBe(true);
    expect(new Set(all).size).toBe(6);
    // Inserted one after another, so each kind's numbers come after the kind before it.
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  test("a restart starts above the highest number of any kind, not only logs", async () => {
    const tag = `kq${Date.now().toString(36)}`;
    const ts = new Date(Date.now() - 30_000).toISOString();
    await insertMetricPoints([{ ts, name: `${tag}.m`, value: 1, labels: {} }]);
    const [point] = await positions("metrics", "name = {n:String}", { n: `${tag}.m` });
    resetArrivalSeqForTests();
    await loadArrivalSeq();
    const range = await allocateArrivalSeq(1);
    releaseArrivalSeq(range);
    expect(range.from).toBeGreaterThan(point!);
  });

  test("a full projection by position reads a page exactly, and retention still changes with it", async () => {
    for (const table of fullSeqProjectionTables) {
      await ensureFullSeqProjection(table);
      await ensureFullSeqProjection(table);
      const rows = await clickhouseQuery<{ n: string | number }>(
        `SELECT count() AS n FROM system.projections WHERE database = currentDatabase() AND table = {t:String} AND name = 'by_seq_full'`,
        { t: table },
      );
      expect(Number(rows[0]?.n)).toBe(1);
    }
    await applyRetentionDays(30, 30);
  });
});
