import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseQuery, pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { insertMetricBuckets, insertMetricPoints } from "../ingest/metrics";
import { insertSpans } from "../ingest/otlp-traces-route";
import { insertProfileSamples } from "../ingest/otlp-profiles-route";
import { recordPushResults } from "../alerts/monitor-results";
import { arrivalSeqSettled, loadArrivalSeq } from "../ingest/arrival-seq";
import { readFeed, type OtherKind } from "./feed";
import { decodeFeed, encodeFeed, insertPulledNative } from "./wire";

/** A kind's rows that carry `tag`, as stored, less where they live (position, arrival, origin). */
async function held(kind: OtherKind, tag: string, where: string): Promise<string[]> {
  const rows = await clickhouseQuery<Record<string, unknown>>(
    `SELECT * EXCEPT (tenant_id, seq, arrived, toposcope, src_id, src_seq) FROM ${kind} WHERE ${where} AND positionUTF8(toString(tuple(*)), {tag:String}) > 0`,
    { tag },
  );
  return rows.map((r) => JSON.stringify(r)).sort();
}

describe("the feed sends ClickHouse Native (#327)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the wire");
    await migrateStore();
    await loadArrivalSeq();
  });

  test("every other kind goes through as Native, stored row for row as at the source, once", async () => {
    const tag = `nw${Date.now().toString(36)}`;
    const source = { id: `src-${tag}`, name: `edge-${tag}` };
    const before = arrivalSeqSettled();
    const ts = new Date(Date.now() - 30_000).toISOString();
    await insertSpans([{ trace_id: `${tag}t`, span_id: `${tag}s`, parent_span_id: "", service: tag, name: "GET /", ts, duration_ms: 2, status: "ok", attrs: { "host.name": "h1", k: "v" } }]);
    await insertMetricPoints([1, 2, 3].map((v) => ({ ts, name: `${tag}.m`, value: v, labels: { host: "h1" } })));
    await insertMetricBuckets([{ ts, name: `${tag}.h`, labels: {}, le: [1, 5], n: [2, 1, 0] }]);
    await insertProfileSamples([{ profile_id: `${tag}p`, service: tag, ts, duration_ms: 1, sample_type: "cpu", sample_unit: "ns", period_type: "cpu", period_unit: "ns", trace_id: `${tag}t`, span_id: `${tag}s`, frames: ["main", "f"], value: 7 }]);
    await recordPushResults([{ monitor_id: `${tag}mon`, at: Date.now() - 30_000, result: "warn", exit_code: 1, duration_ms: 3, value: 0.5, unit: "s", message: "slow", host: "h1", via: "push" }]);
    const kinds = ["spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"] as const;
    const reply = await readFeed({ id: "f_wire", q: "", after: before, limit: 5_000, kinds, positionsOnly: true });
    const wire = decodeFeed(await encodeFeed(reply, source.id));
    expect(wire.header.through).toBe(reply.through);
    const at = (kind: OtherKind) => wire.header.blocks.find((b) => b.kind === kind)!;
    for (const kind of kinds) {
      const original = await held(kind, tag, "src_id = ''");
      expect(original.length).toBeGreaterThan(0);
      const { stored } = await insertPulledNative(at(kind), wire.blocks.get(kind)!, source, `puller-${tag}`);
      expect(stored).toBeGreaterThanOrEqual(original.length);
      expect(await held(kind, tag, `src_id = '${source.id}'`)).toEqual(original);
      // Sent again, or a retry: nothing is stored twice.
      expect((await insertPulledNative(at(kind), wire.blocks.get(kind)!, source, `puller-${tag}`)).stored).toBe(0);
      // Back at the instance it entered: not stored either.
      expect((await insertPulledNative(at(kind), wire.blocks.get(kind)!, source, source.id)).stored).toBe(0);
    }
    const copied = await clickhouseQuery<{ toposcope: string; ord: number }>(
      `SELECT any(toposcope) AS toposcope, toUInt8(arraySort(groupArray(src_seq)) = arrayMap(x -> x.2, arraySort(groupArray((seq, src_seq))))) AS ord
       FROM metrics WHERE src_id = {sid:String}`,
      { sid: source.id },
    );
    // Each copy names where it entered, and takes positions here in the order it was sent.
    expect(copied[0]).toEqual({ toposcope: source.name, ord: 1 });
  });

  test("20,000 points keep their order through parallel parsing", async () => {
    const tag = `nb${Date.now().toString(36)}`;
    const source = { id: `src-${tag}`, name: `edge-${tag}` };
    const before = arrivalSeqSettled();
    const ts = new Date(Date.now() - 30_000).toISOString();
    for (let k = 0; k < 4; k++) {
      await insertMetricPoints(Array.from({ length: 5_000 }, (_, i) => ({ ts, name: `${tag}.m`, value: k * 5_000 + i, labels: {} })));
    }
    let after = before;
    const settled = arrivalSeqSettled();
    while (after < settled) {
      const reply = await readFeed({ id: "f_wire", q: "", after, limit: 5_000, kinds: ["metrics"], positionsOnly: true, settled });
      const wire = decodeFeed(await encodeFeed(reply, source.id));
      for (const b of wire.header.blocks) await insertPulledNative(b, wire.blocks.get(b.kind)!, source, `puller-${tag}`);
      after = reply.through;
    }
    const rows = await clickhouseQuery<{ n: string | number; ord: number }>(
      `SELECT count() AS n, toUInt8(arrayMap(x -> x.2, arraySort(groupArray((seq, src_seq)))) = arraySort(groupArray(src_seq))) AS ord FROM metrics WHERE src_id = {sid:String}`,
      { sid: source.id },
    );
    expect(rows[0]).toEqual({ n: 20_000, ord: 1 });
  }, 120_000);

  test("a body is its header and blocks; one that is cut is refused", async () => {
    const reply = await readFeed({ id: "f_wire", q: "", after: arrivalSeqSettled(), kinds: ["spans"], positionsOnly: true });
    const body = await encodeFeed(reply, "x");
    expect(decodeFeed(body).header.blocks).toEqual([]);
    expect(() => decodeFeed(body.subarray(0, 2))).toThrow();
  });
});
