import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { MAX_BATCH } from "./index";
import { ingestMetricsRoute } from "./metrics";
import { mapOtlpMetrics } from "./otlp-metrics";
import { decodeOtlpMetricsProtobuf, encodeOtlpMetricsProtobuf } from "./otlp-metrics-protobuf";
import { decodeOtlpReply, Losses } from "./otlp-reply";

const DELTA = 1;
const CUMULATIVE = 2;
const T = "1767225600000000000"; // 2026-01-01T00:00:00Z
const TS = "2026-01-01T00:00:00.000Z";

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, value = "x"): Attr => ({ key, value: { stringValue: value } });
const num = (value: number, attributes: Attr[] = []) => ({ timeUnixNano: T, asDouble: value, attributes });

function request(metrics: object[], resource: Attr[] = [attr("service.name", "billing"), attr("host.name", "web-1")]) {
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ metrics }] }] };
}

function mapped(metrics: object[], resource?: Attr[]) {
  const losses = new Losses();
  const out = mapOtlpMetrics(request(metrics, resource), losses);
  return { ...out, losses, kinds: Object.fromEntries(out.kinds) };
}

describe("what an OTLP metric becomes", () => {
  test("a gauge is stored as it is, under its dotted name", () => {
    const out = mapped([{ name: "process.memory.usage", gauge: { dataPoints: [num(1024)] } }]);
    expect(out.points).toEqual([
      { ts: TS, name: "process.memory.usage", value: 1024, labels: { service: "billing", host: "web-1" } },
    ]);
    expect(out.kinds).toEqual({ "process.memory.usage": "gauge" });
    expect(out.losses.message()).toBe("");
  });

  test("an up-down counter's running total is a level, so it is a gauge too", () => {
    const out = mapped([
      {
        name: "http.server.active_requests",
        sum: { aggregationTemporality: CUMULATIVE, isMonotonic: false, dataPoints: [{ timeUnixNano: T, asInt: "7" }] },
      },
    ]);
    expect(out.points.map((p) => p.value)).toEqual([7]);
    expect(out.kinds).toEqual({ "http.server.active_requests": "gauge" });
  });

  test("a counter sent as deltas is the amount per interval", () => {
    const out = mapped([
      {
        name: "app.jobs.processed",
        sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: [num(12), num(3)] },
      },
    ]);
    expect(out.points.map((p) => p.value)).toEqual([12, 3]);
    expect(out.kinds).toEqual({ "app.jobs.processed": "counter" });
  });

  test("a counter sent as a running total is refused, and the reply says what to set", () => {
    const out = mapped([
      {
        name: "app.jobs.processed",
        sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints: [num(12), num(15)] },
      },
      { name: "process.memory.usage", gauge: { dataPoints: [num(1024)] } },
    ]);
    expect(out.points.map((p) => p.name)).toEqual(["process.memory.usage"]);
    expect(out.losses.rejectedCount).toBe(2);
    expect(out.losses.message()).toBe(
      "running totals, which need the exporter’s temporality preference set to delta: 2 rejected",
    );
  });

  test("a histogram is two counters, its count and its sum", () => {
    const out = mapped([
      {
        name: "http.server.request.duration",
        histogram: {
          aggregationTemporality: DELTA,
          dataPoints: [
            {
              timeUnixNano: T,
              count: "40",
              sum: 3.2,
              bucketCounts: ["30", "10"],
              explicitBounds: [0.1],
              attributes: [attr("http.route", "/pay")],
            },
          ],
        },
      },
    ]);
    const labels = { "http.route": "/pay", service: "billing", host: "web-1" };
    expect(out.points).toEqual([
      { ts: TS, name: "http.server.request.duration.count", value: 40, labels },
      { ts: TS, name: "http.server.request.duration.sum", value: 3.2, labels },
    ]);
    expect(out.kinds).toEqual({
      "http.server.request.duration.count": "counter",
      "http.server.request.duration.sum": "counter",
    });
    // Buckets are not kept yet, and that is not reported on every export.
    expect(out.losses.message()).toBe("");
  });

  test("a histogram with no sum keeps its count", () => {
    const out = mapped([
      { name: "queue.depth", histogram: { aggregationTemporality: DELTA, dataPoints: [{ timeUnixNano: T, count: "4" }] } },
    ]);
    expect(out.points.map((p) => [p.name, p.value])).toEqual([["queue.depth.count", 4]]);
  });

  test("a running-total histogram, an exponential histogram and a summary are refused by name", () => {
    const out = mapped([
      { name: "a", histogram: { aggregationTemporality: CUMULATIVE, dataPoints: [{ timeUnixNano: T, count: "4" }] } },
      { name: "b", exponentialHistogram: { aggregationTemporality: DELTA, dataPoints: [{}, {}] } },
      { name: "c", summary: { dataPoints: [{}] } },
    ]);
    expect(out.points).toEqual([]);
    expect(out.losses.rejectedCount).toBe(4);
    expect(out.losses.message()).toBe(
      "running totals, which need the exporter’s temporality preference set to delta: 1 rejected; exponential histograms: 2 rejected; summaries: 1 rejected",
    );
  });

  test("the point's attributes become labels first, then the resource's", () => {
    const out = mapped(
      [{ name: "cpu", gauge: { dataPoints: [num(0.5, [attr("core", "0"), attr("service.name", "from-point")])] } }],
      [attr("service.name", "billing"), attr("host.name", "web-1"), attr("process.pid", "41")],
    );
    expect(out.points[0]!.labels).toEqual({
      core: "0",
      service: "from-point",
      host: "web-1",
      "process.pid": "41",
    });
  });

  test("a name a row cannot hold is refused; a point with no recorded value is skipped", () => {
    const out = mapped([
      { name: "http/requests-total", gauge: { dataPoints: [num(1)] } },
      { name: "cpu", gauge: { dataPoints: [{ timeUnixNano: T, flags: 1 }, { timeUnixNano: T }] } },
    ]);
    expect(out.points).toEqual([]);
    expect(out.losses.message()).toBe(
      "a metric name that cannot be stored: 1 rejected; a value that is not a number: 1 rejected",
    );
  });

  test("labels past the cap are a warning", () => {
    const wide = Array.from({ length: 60 }, (_, i) => attr(`label_${i}`));
    const out = mapped([{ name: "cpu", gauge: { dataPoints: [num(1, wide)] } }]);
    expect(Object.keys(out.points[0]!.labels)).toHaveLength(50);
    expect(out.losses.rejectedCount).toBe(0);
    expect(out.losses.message()).toBe("labels past the 50-label cap: cut on 1");
  });

  test("protobuf says the same as JSON", () => {
    const sent = request([
      { name: "process.memory.usage", gauge: { dataPoints: [{ timeUnixNano: T, asInt: "1024", attributes: [attr("pool", "heap")] }] } },
      { name: "app.jobs.processed", sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: [num(12)] } },
      { name: "http.server.request.duration", histogram: { aggregationTemporality: DELTA, dataPoints: [{ timeUnixNano: T, count: "40", sum: 3.2 }] } },
      { name: "b", exponentialHistogram: { dataPoints: [{}, {}] } },
      { name: "c", summary: { dataPoints: [{}] } },
    ]);
    const fromJson = mapOtlpMetrics(sent, new Losses());
    const losses = new Losses();
    const fromProtobuf = mapOtlpMetrics(decodeOtlpMetricsProtobuf(encodeOtlpMetricsProtobuf(sent)), losses);
    expect(fromProtobuf.points).toEqual(fromJson.points);
    expect([...fromProtobuf.kinds]).toEqual([...fromJson.kinds]);
    expect(losses.message()).toBe("exponential histograms: 2 rejected; summaries: 1 rejected");
  });

  test("a request with no resourceMetrics cannot be read", () => {
    expect(() => mapOtlpMetrics({}, new Losses())).toThrow("resourceMetrics is required");
  });
});

describe("POST /v1/metrics", () => {
  const app = new Hono();
  app.post("/v1/metrics", ingestMetricsRoute);
  /** The rows each table was asked to store. ClickHouse itself is stubbed. */
  let stored: Record<string, Array<Record<string, unknown>>>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    stored = {};
    forgetMetricKinds();
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const query = new URL(String(input)).searchParams.get("query") ?? "";
        const table = query.match(/^INSERT INTO (\w+) /)?.[1];
        if (!table) {
          throw new Error(`Unexpected fetch: ${String(input)}`);
        }
        (stored[table] ??= []).push(
          ...String(init?.body ?? "").split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
        );
        return new Response("");
      },
      { preconnect: realFetch.preconnect },
    );
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const postJson = (body: unknown) =>
    Promise.resolve(
      app.request("/v1/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const stock = [
    { name: "process.memory.usage", gauge: { dataPoints: [num(1024)] } },
    { name: "app.jobs.processed", sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: [num(12)] } },
  ];

  test("an OTLP JSON request is stored, and each name's kind with it", async () => {
    const res = await postJson(request(stock));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });
    expect(stored.metrics!.map((row) => [row.name, row.value])).toEqual([
      ["process.memory.usage", 1024],
      ["app.jobs.processed", 12],
    ]);
    expect(stored.metric_kinds!.map((row) => [row.name, row.kind])).toEqual([
      ["process.memory.usage", "gauge"],
      ["app.jobs.processed", "counter"],
    ]);
  });

  test("a name's kind is written once, not on every export", async () => {
    await postJson(request(stock));
    await postJson(request(stock));
    expect(stored.metrics).toHaveLength(4);
    expect(stored.metric_kinds).toHaveLength(2);
  });

  test("a protobuf request is stored and answered in protobuf", async () => {
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.from(encodeOtlpMetricsProtobuf(request(stock))),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(stored.metrics).toHaveLength(2);
  });

  test("what is not taken is counted in the reply, and the rest still lands", async () => {
    const mixed = request([
      ...stock,
      { name: "app.jobs.total", sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints: [num(99)] } },
      { name: "latency", summary: { dataPoints: [{}] } },
    ]);
    const json = await postJson(mixed);
    expect(await json.json()).toEqual({
      ingested: 2,
      partialSuccess: {
        rejectedDataPoints: "2",
        errorMessage:
          "running totals, which need the exporter’s temporality preference set to delta: 1 rejected; summaries: 1 rejected",
      },
    });
    const protobuf = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.from(encodeOtlpMetricsProtobuf(mixed)),
    });
    expect(decodeOtlpReply(new Uint8Array(await protobuf.arrayBuffer())).rejected).toBe(2);
    expect(stored.metrics).toHaveLength(4);
  });

  test("an OTLP request is limited by its size, not by a count of points", async () => {
    const many = Array.from({ length: MAX_BATCH * 3 }, (_, i) => num(i, [attr("series", String(i))]));
    const res = await postJson(request([{ name: "cpu", gauge: { dataPoints: many } }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: MAX_BATCH * 3 });
  });

  test("the plain JSON point still works, has no kind, and keeps its cap", async () => {
    const res = await postJson({ name: "cpu_seconds", value: 1.5, labels: { service: "api" } });
    expect(await res.json()).toEqual({ ingested: 1 });
    expect(stored.metric_kinds).toBeUndefined();
    const over = await postJson(Array.from({ length: MAX_BATCH + 1 }, () => ({ name: "cpu_seconds", value: 1 })));
    expect(over.status).toBe(400);
  });

  test("a protobuf body that cannot be read is a 400", async () => {
    const res = await app.request("/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.from(new Uint8Array([0xff, 0xff, 0xff])),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid OTLP protobuf body" });
  });
});
