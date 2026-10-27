import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { hereName, setHereName } from "../shared/here";
import { migrateStore } from "../shared/migrate";
import { insertProfileSamples } from "../ingest/otlp-profiles-route";
import { insertSpans } from "../ingest/otlp-traces-route";
import { searchProfile } from "./profiles";
import { pulledAt, searchTrace } from "./traces";

function hex(n: number, tag: string): string {
  // The tag's end differs between ids, so it is read from the end.
  const base = Buffer.from(tag).toString("hex");
  return ("a".repeat(n) + base).slice(-n);
}

describe("a trace and a profile say where they entered (#330, #332)", () => {
  const before = hereName();
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for where a span entered");
    await migrateStore();
    setHereName("central");
  });
  afterAll(() => setHereName(before));

  test("spans from this instance and a pulled source come back in one trace, each with its toposcope", async () => {
    const tag = `en${Date.now().toString(36)}`;
    const traceId = hex(32, tag);
    const ts = new Date(Date.now() - 60_000).toISOString();
    await insertSpans([
      { trace_id: traceId, span_id: hex(16, `${tag}r`), parent_span_id: "", service: "api", name: "GET /checkout", ts, duration_ms: 1180, status: "ok", attrs: {} },
    ]);
    const arrived = new Date(Date.now() - 5_000).toISOString();
    await clickhouseInsertJsonEachRow(
      JSON.stringify({
        tenant_id: "default",
        trace_id: traceId,
        span_id: hex(16, `${tag}c`),
        parent_span_id: hex(16, `${tag}r`),
        service: "billing",
        name: "POST /charge",
        ts: toClickHouseDateTime(ts),
        duration_ms: 402,
        status: "error",
        attrs: {},
        seq: 0,
        arrived: toClickHouseDateTime(arrived),
        toposcope: "edge-2",
        src_id: "edge-2-id",
        src_seq: 7,
      }),
      "spans",
    );
    const trace = await searchTrace(traceId);
    expect(trace.total).toBe(2);
    const own = trace.spans.find((s) => s.service === "api")!;
    const pulled = trace.spans.find((s) => s.service === "billing")!;
    expect(own.toposcope).toBe("central");
    expect(own.pulled_at).toBeNull();
    expect(pulled.toposcope).toBe("edge-2");
    expect(pulled.pulled_at).toBe(arrived);
  });

  test("a profile pulled with its span names its source; one that entered here does not say pulled", async () => {
    const tag = `ep${Date.now().toString(36)}`;
    const traceId = hex(32, tag);
    const ts = new Date(Date.now() - 60_000).toISOString();
    const arrived = new Date(Date.now() - 4_000).toISOString();
    const pulledSpan = hex(16, `${tag}p`);
    await clickhouseInsertJsonEachRow(
      JSON.stringify({
        tenant_id: "default",
        profile_id: `${tag}pp`,
        service: "billing",
        ts: toClickHouseDateTime(ts),
        duration_ms: 402,
        sample_type: "cpu",
        sample_unit: "nanoseconds",
        period_type: "cpu",
        period_unit: "nanoseconds",
        trace_id: traceId,
        span_id: pulledSpan,
        frames: ["main", "charge"],
        value: 9,
        seq: 0,
        arrived: toClickHouseDateTime(arrived),
        toposcope: "edge-2",
        src_id: "edge-2-id",
        src_seq: 8,
      }),
      "profile_samples",
    );
    const ownSpan = hex(16, `${tag}o`);
    await insertProfileSamples([
      {
        profile_id: `${tag}op`, service: "api", ts, duration_ms: 3, sample_type: "cpu", sample_unit: "nanoseconds",
        period_type: "cpu", period_unit: "nanoseconds", trace_id: traceId, span_id: ownSpan, frames: ["main"], value: 5,
      },
    ]);
    const pulled = await searchProfile(traceId, pulledSpan);
    expect(pulled.stacks).toEqual([{ frames: ["main", "charge"], value: 9 }]);
    expect(pulled.toposcope).toBe("edge-2");
    expect(pulled.pulled_at).toBe(arrived);
    const own = await searchProfile(traceId, ownSpan);
    expect(own.toposcope).toBe("central");
    expect(own.pulled_at).toBeNull();
    const none = await searchProfile(traceId, hex(16, `${tag}n`));
    expect(none.stacks).toEqual([]);
    expect(none.toposcope).toBe("");
    expect(none.pulled_at).toBeNull();
  });

  test("pulledAt reads ClickHouse's boolean and time", () => {
    expect(pulledAt(1, "2026-10-27 13:23:24.000")).toBe("2026-10-27T13:23:24.000Z");
    expect(pulledAt("1", "2026-10-27 13:23:24.000")).toBe("2026-10-27T13:23:24.000Z");
    expect(pulledAt(0, "2026-10-27 13:23:24.000")).toBeNull();
    expect(pulledAt(true, "")).toBeNull();
  });
});
