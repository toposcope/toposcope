import { beforeAll, describe, expect, test } from "bun:test";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { insertEvents } from "../ingest/index";
import { insertMetricPoints } from "../ingest/metrics";
import { insertSpans } from "../ingest/otlp-traces-route";
import { insertProfileSamples } from "../ingest/otlp-profiles-route";
import { recordPushResults } from "../alerts/monitor-results";
import { arrivalSeqSettled, loadArrivalSeq } from "../ingest/arrival-seq";
import { readFeed } from "./feed";
import { kindFilter } from "./kind-filter";

const notSent = (q: string, kind: Parameters<typeof kindFilter>[1]) => {
  const f = kindFilter(q, kind, {});
  return "not_sent" in f ? f.not_sent : null;
};

describe("a link's filter on each kind (#326)", () => {
  test("an empty filter sends every kind whole", () => {
    for (const kind of ["spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"] as const) {
      expect(kindFilter("", kind, {})).toEqual({ sql: "" });
    }
  });

  test("a filter that names level or words in the message sends none of the other kinds, and says why", () => {
    for (const kind of ["spans", "metrics", "metric_buckets", "monitor_results"] as const) {
      expect(notSent("level:error", kind)).toBe("the filter names level");
      expect(notSent('"card declined"', kind)).toBe("the filter names words in the message");
    }
    expect(notSent("level:error", "profile_samples")).toBe("they go with their spans, and the filter names level");
  });

  test("service, host, toposcope and other keys map onto each kind's own columns", () => {
    const p: Record<string, string> = {};
    expect(kindFilter("service:api host:edge-2*", "spans", p)).toEqual({ sql: "(service = {kf0:String} AND startsWith(attrs['host.name'], {kf1:String}))" });
    expect(kindFilter("host:edge-2", "metrics", {})).toEqual({ sql: "labels['host'] = {kf0:String}" });
    expect(kindFilter("route:/pay", "metric_buckets", {})).toEqual({ sql: "labels[{kf0:String}] = {kf1:String}" });
    expect(kindFilter("host:db-1", "monitor_results", {})).toEqual({ sql: "host = {kf0:String}" });
    expect(kindFilter("toposcope:edge-1", "monitor_results", {})).toEqual({ sql: "toposcope = {kf0:String}" });
  });

  test("a monitor is decided by the service and host it names (#335); other keys it has not", () => {
    expect(kindFilter("service:api", "monitor_results", {})).toEqual({ sql: "service = {kf0:String}" });
    expect(notSent("route:/pay", "monitor_results")).toBe("the filter names route");
  });

  describe("read through the feed", () => {
    beforeAll(async () => {
      process.env.CLICKHOUSE_USER ??= "default";
      process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
      if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the filter");
      await migrateStore();
      await loadArrivalSeq();
    });

    test("host:<edge> sends that host's logs, spans, points, its spans' profiles and its monitors, and nothing else", async () => {
      const tag = `kf${Date.now().toString(36)}`;
      const edge = `${tag}-edge`;
      const other = `${tag}-other`;
      const before = arrivalSeqSettled();
      const ts = new Date(Date.now() - 30_000).toISOString();
      const at = Date.now() - 30_000;
      for (const host of [edge, other]) {
        await insertEvents([{ ts, service: tag, host, level: "info", message: "x" }]);
        await insertSpans([{ trace_id: `${host}t`, span_id: `${host}s`, parent_span_id: "", service: tag, name: "GET /", ts, duration_ms: 1, status: "ok", attrs: { "host.name": host } }]);
        await insertMetricPoints([{ ts, name: `${tag}.m`, value: 1, labels: { host } }]);
        await insertProfileSamples([{ profile_id: `${host}p`, service: tag, ts, duration_ms: 1, sample_type: "cpu", sample_unit: "ns", period_type: "cpu", period_unit: "ns", trace_id: `${host}t`, span_id: `${host}s`, frames: ["main"], value: 1 }]);
        await recordPushResults([{ monitor_id: `${tag}-mon`, at, result: "ok", exit_code: null, duration_ms: 1, value: null, unit: null, message: host, host, via: "http" }]);
      }
      // A profile with no span goes by service; this filter names host, so it does not go.
      await insertProfileSamples([{ profile_id: `${tag}-loose`, service: tag, ts, duration_ms: 1, sample_type: "cpu", sample_unit: "ns", period_type: "cpu", period_unit: "ns", trace_id: "", span_id: "", frames: ["main"], value: 1 }]);
      const reply = await readFeed({ id: "f_kf", q: `host:${edge}`, after: before, limit: 5_000 });
      const mine = (rows: Array<Record<string, unknown>>) => rows.filter((r) => JSON.stringify(r).includes(tag));
      expect(reply.rows.filter((r) => r.service === tag).map((r) => r.host)).toEqual([edge]);
      expect(mine(reply.kinds.spans!.rows).map((r) => r.span_id)).toEqual([`${edge}s`]);
      expect(mine(reply.kinds.metrics!.rows).map((r) => (r.labels as Record<string, string>).host)).toEqual([edge]);
      expect(mine(reply.kinds.profile_samples!.rows).map((r) => r.profile_id)).toEqual([`${edge}p`]);
      expect(mine(reply.kinds.monitor_results!.rows).map((r) => r.host)).toEqual([edge]);

      const errorsOnly = await readFeed({ id: "f_kf", q: "level:error", after: before, limit: 5_000 });
      expect(errorsOnly.kinds.spans).toEqual({ rows: [], gone: null, not_sent: "the filter names level" });
      expect(errorsOnly.kinds.metrics?.not_sent).toBe("the filter names level");
      expect(errorsOnly.kinds.profile_samples?.not_sent).toBe("they go with their spans, and the filter names level");
      expect(errorsOnly.kinds.monitor_results?.not_sent).toBe("the filter names level");
    });
  });
});
