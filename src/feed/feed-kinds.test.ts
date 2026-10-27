import { beforeAll, describe, expect, test } from "bun:test";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { insertEvents } from "../ingest/index";
import { insertMetricBuckets, insertMetricPoints } from "../ingest/metrics";
import { insertSpans } from "../ingest/otlp-traces-route";
import { insertProfileSamples } from "../ingest/otlp-profiles-route";
import { recordPushResults } from "../alerts/monitor-results";
import { arrivalSeqSettled, loadArrivalSeq } from "../ingest/arrival-seq";
import { kindGone, parseKinds, readFeed, type FeedReply } from "./feed";

describe("the feed reads every kind by one position (#325)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the feed");
    await migrateStore();
    await loadArrivalSeq();
  });

  test("seven kinds interleaved, paged from before them to settled, each row arrives once in arrival order", async () => {
    const tag = `fk${Date.now().toString(36)}`;
    const before = arrivalSeqSettled();
    const ts = new Date(Date.now() - 30_000).toISOString();
    const at = Date.now() - 30_000;
    for (let round = 0; round < 3; round++) {
      await insertEvents([{ ts, service: tag, level: "info", message: `log ${round}` }]);
      await insertSpans([{ trace_id: `${tag}t${round}`, span_id: `${tag}s${round}`, parent_span_id: "", service: tag, name: "GET /", ts, duration_ms: 1, status: "ok", attrs: {} }]);
      await insertMetricPoints([{ ts, name: `${tag}.m`, value: round, labels: {} }, { ts, name: `${tag}.m`, value: round + 10, labels: {} }]);
      await insertMetricBuckets([{ ts, name: `${tag}.h`, labels: {}, le: [1], n: [round, 0] }]);
      await insertProfileSamples([{ profile_id: `${tag}p${round}`, service: tag, ts, duration_ms: 1, sample_type: "cpu", sample_unit: "ns", period_type: "cpu", period_unit: "ns", trace_id: `${tag}t${round}`, span_id: `${tag}s${round}`, frames: ["main"], value: 1 }]);
      await recordPushResults([{ monitor_id: `${tag}mon`, at, result: "ok", exit_code: null, duration_ms: 1, value: null, unit: null, message: `r${round}`, host: "h", via: "http" }]);
    }
    const settled = arrivalSeqSettled();
    const seen: Array<{ kind: string; seq: number }> = [];
    let after = before;
    for (let page = 0; page < 200 && after < settled; page++) {
      const reply: FeedReply = await readFeed({ id: "f_kinds", q: "", after, limit: 4, settled });
      // A reply groups rows by kind; every row in it sits in (after, through], each kind in order.
      const inPage = [...reply.rows.map((r) => r.seq), ...Object.values(reply.kinds).flatMap((p) => p!.rows.map((r) => Number(r.seq)))];
      expect(inPage.every((n) => n > after && n <= reply.through)).toBe(true);
      for (const kpage of [reply.rows.map((r) => r.seq), ...Object.values(reply.kinds).map((p) => p!.rows.map((r) => Number(r.seq)))]) {
        expect(kpage).toEqual([...kpage].sort((x, y) => x - y));
      }
      for (const row of reply.rows) if (row.service === tag) seen.push({ kind: "logs", seq: row.seq });
      for (const [kind, kpage] of Object.entries(reply.kinds)) {
        for (const row of kpage!.rows) {
          const mine = row.service === tag || row.monitor_id === `${tag}mon` || String(row.name ?? "").startsWith(tag);
          if (mine) seen.push({ kind, seq: Number(row.seq) });
        }
      }
      expect(reply.through).toBeGreaterThanOrEqual(after);
      after = reply.through;
    }
    const counts = Object.fromEntries(["logs", "spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"].map((k) => [k, seen.filter((x) => x.kind === k).length]));
    expect(counts).toEqual({ logs: 3, spans: 3, metrics: 6, metric_buckets: 3, profile_samples: 3, monitor_results: 3 });
    const seqs = seen.map((x) => x.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("a page never holds more than its limit across all kinds", async () => {
    const settled = arrivalSeqSettled();
    const reply = await readFeed({ id: "f_kinds", q: "", after: Math.max(0, settled - 500), limit: 7, settled });
    const total = reply.rows.length + Object.values(reply.kinds).reduce((n, p) => n + p!.rows.length, 0);
    expect(total).toBeLessThanOrEqual(7);
  });

  test("only the kinds asked for are read", async () => {
    const settled = arrivalSeqSettled();
    const reply = await readFeed({ id: "f_kinds", q: "", after: Math.max(0, settled - 50), kinds: ["spans"], settled });
    expect(reply.rows).toEqual([]);
    expect(reply.marks).toEqual([]);
    expect(Object.keys(reply.kinds)).toEqual(["spans"]);
    expect(parseKinds("logs,spans")).toEqual(["logs", "spans"]);
    expect(parseKinds("")).toHaveLength(7);
    expect(parseKinds("logs,nope")).toEqual({ error: "unknown kind: nope" });
  });

  test("a kind past its own retention is a hole for that kind only", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    const metricsHorizon = new Date(now - 7 * 86_400_000).toISOString();
    const logsHorizon = new Date(now - 30 * 86_400_000).toISOString();
    // Metrics keep 7 days: their oldest left is at the edge, so what was below it is gone.
    expect(kindGone({ after: 10, oldest: 500, oldestTs: new Date(now - 7 * 86_400_000 + 3_600_000).toISOString(), horizon: metricsHorizon })).toEqual({ from: 11, to: 499 });
    // Logs keep 30 days and their oldest is 8 days old: positions below it were never theirs.
    expect(kindGone({ after: 10, oldest: 400, oldestTs: new Date(now - 8 * 86_400_000).toISOString(), horizon: logsHorizon })).toBeNull();
    expect(kindGone({ after: 499, oldest: 500, oldestTs: metricsHorizon, horizon: metricsHorizon })).toBeNull();
  });
});
