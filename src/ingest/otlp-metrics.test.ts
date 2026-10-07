import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { forgetMetricKinds } from "../shared/metric-kinds";
import { MAX_BATCH } from "./index";
import { ingestMetricsRoute } from "./metrics";
import { mapOtlpMetrics } from "./otlp-metrics";
import { decodeOtlpMetricsProtobuf, encodeOtlpMetricsProtobuf } from "./otlp-metrics-protobuf";
import { decodeOtlpReply, Losses } from "./otlp-reply";
import { RunningTotals } from "./running-totals";

const DELTA = 1;
const CUMULATIVE = 2;
const T = "1767225600000000000"; // 2026-01-01T00:00:00Z
const TS = "2026-01-01T00:00:00.000Z";
const T_MS = 1_767_225_600_000;
const nano = (ms: number) => `${ms}000000`;
/** A process that has been up for an hour: a series under an hour old is counted whole. */
const upAnHour = () => new RunningTotals(T_MS - 3_600_000, () => T_MS);

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, value = "x"): Attr => ({ key, value: { stringValue: value } });
const num = (value: number, attributes: Attr[] = []) => ({ timeUnixNano: T, asDouble: value, attributes });

function request(metrics: object[], resource: Attr[] = [attr("service.name", "billing"), attr("host.name", "web-1")]) {
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ metrics }] }] };
}

function mapped(metrics: object[], resource?: Attr[], totals = upAnHour()) {
  const losses = new Losses();
  const out = mapOtlpMetrics(request(metrics, resource), losses, totals);
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

  test("an exponential histogram and a summary are refused by name, and so is a sum that does not say what it is", () => {
    const out = mapped([
      { name: "b", exponentialHistogram: { aggregationTemporality: DELTA, dataPoints: [{}, {}] } },
      { name: "c", summary: { dataPoints: [{}] } },
      { name: "d", sum: { isMonotonic: true, dataPoints: [num(1)] } },
    ]);
    expect(out.points).toEqual([]);
    expect(out.losses.rejectedCount).toBe(4);
    expect(out.losses.message()).toBe(
      "exponential histograms: 2 rejected; summaries: 1 rejected; a sum or histogram that does not say its temporality: 1 rejected",
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
    const fromJson = mapOtlpMetrics(sent, new Losses(), upAnHour());
    const losses = new Losses();
    const fromProtobuf = mapOtlpMetrics(
      decodeOtlpMetricsProtobuf(encodeOtlpMetricsProtobuf(sent)),
      losses,
      upAnHour(),
    );
    expect(fromProtobuf.points).toEqual(fromJson.points);
    expect([...fromProtobuf.kinds]).toEqual([...fromJson.kinds]);
    expect(losses.message()).toBe("exponential histograms: 2 rejected; summaries: 1 rejected");
  });

  test("a request with no resourceMetrics cannot be read", () => {
    expect(() => mapOtlpMetrics({}, new Losses(), upAnHour())).toThrow("resourceMetrics is required");
  });
});

describe("a counter or a histogram sent as a running total", () => {
  /** One export of a counter and a histogram that both started `startedAgoMs` before the first export. */
  const exportAt = (minute: number, counter: number, count: number, sum: number, startedAgoMs = 30_000) => {
    const start = nano(T_MS - startedAgoMs);
    const time = nano(T_MS + minute * 60_000);
    return [
      {
        name: "app.jobs.processed",
        sum: {
          aggregationTemporality: CUMULATIVE,
          isMonotonic: true,
          dataPoints: [{ startTimeUnixNano: start, timeUnixNano: time, asInt: String(counter) }],
        },
      },
      {
        name: "http.server.request.duration",
        histogram: {
          aggregationTemporality: CUMULATIVE,
          dataPoints: [{ startTimeUnixNano: start, timeUnixNano: time, count: String(count), sum }],
        },
      },
    ];
  };
  const values = (out: { points: Array<{ name: string; value: number }> }) =>
    Object.fromEntries(out.points.map((point) => [point.name.split(".").pop()!, point.value]));

  test("is stored as the amount since it was last seen, and is a counter", () => {
    const totals = upAnHour();
    const first = mapped(exportAt(0, 12, 40, 3.5), undefined, totals);
    // The service started thirty seconds ago and this process an hour ago: all of it is new.
    expect(values(first)).toEqual({ processed: 12, count: 40, sum: 3.5 });
    expect(first.kinds).toEqual({
      "app.jobs.processed": "counter",
      "http.server.request.duration.count": "counter",
      "http.server.request.duration.sum": "counter",
    });
    const second = mapped(exportAt(1, 20, 65, 5.5), undefined, totals);
    expect(values(second)).toEqual({ processed: 8, count: 25, sum: 2 });
    expect(second.points[0]!.ts).toBe("2026-01-01T00:01:00.000Z");
    expect(second.losses.message()).toBe("");
  });

  test("a total that did not move stores nothing, as a delta exporter would send nothing", () => {
    const totals = upAnHour();
    mapped(exportAt(0, 12, 40, 3.5), undefined, totals);
    const quiet = mapped(exportAt(1, 12, 40, 3.5), undefined, totals);
    expect(quiet.points).toEqual([]);
    expect(quiet.losses.message()).toBe("");
  });

  test("after the service restarts, its new totals are counted whole", () => {
    const totals = upAnHour();
    mapped(exportAt(0, 900, 4_000, 300, 30_000), undefined, totals);
    // The same series, started again a minute later.
    const restarted = mapped(exportAt(2, 3, 9, 0.7, -90_000), undefined, totals);
    expect(values(restarted)).toEqual({ processed: 3, count: 9, sum: 0.7 });
  });

  test("a series that was running before this process started only sets a baseline, and the reply says so", () => {
    const justBooted = new RunningTotals(T_MS - 5_000, () => T_MS);
    const first = mapped(exportAt(0, 900, 4_000, 300, 86_400_000), undefined, justBooted);
    expect(first.points).toEqual([]);
    expect(first.losses.rejectedCount).toBe(0);
    expect(first.losses.message()).toBe(
      "running totals seen for the first time from a series that was already running, taken as its baseline: 2",
    );
    const second = mapped(exportAt(1, 905, 4_020, 301, 86_400_000), undefined, justBooted);
    expect(values(second)).toEqual({ processed: 5, count: 20, sum: 1 });
  });

  test("two series of one name are told apart by their labels", () => {
    const totals = upAnHour();
    const point = (queue: string, value: number, minute: number) => ({
      startTimeUnixNano: nano(T_MS - 30_000),
      timeUnixNano: nano(T_MS + minute * 60_000),
      asInt: String(value),
      attributes: [attr("queue", queue)],
    });
    const send = (minute: number, charges: number, refunds: number) =>
      mapped(
        [
          {
            name: "app.jobs.processed",
            sum: {
              aggregationTemporality: CUMULATIVE,
              isMonotonic: true,
              dataPoints: [point("charges", charges, minute), point("refunds", refunds, minute)],
            },
          },
        ],
        undefined,
        totals,
      ).points.map((p) => [p.labels.queue, p.value]);
    expect(send(0, 10, 100)).toEqual([["charges", 10], ["refunds", 100]]);
    expect(send(1, 14, 101)).toEqual([["charges", 4], ["refunds", 1]]);
  });

  test("protobuf carries the start time too", () => {
    const totals = upAnHour();
    const viaProtobuf = (metrics: object[]) =>
      mapOtlpMetrics(decodeOtlpMetricsProtobuf(encodeOtlpMetricsProtobuf(request(metrics))), new Losses(), totals);
    expect(values(viaProtobuf(exportAt(0, 12, 40, 3.5)))).toEqual({ processed: 12, count: 40, sum: 3.5 });
    expect(values(viaProtobuf(exportAt(1, 20, 65, 5.5)))).toEqual({ processed: 8, count: 25, sum: 2 });
  });

  test("an up-down counter's running total is still a level, not converted", () => {
    const totals = upAnHour();
    const level = (minute: number, value: number) =>
      mapped(
        [
          {
            name: "http.server.active_requests",
            sum: {
              aggregationTemporality: CUMULATIVE,
              isMonotonic: false,
              dataPoints: [{ startTimeUnixNano: nano(T_MS - 30_000), timeUnixNano: nano(T_MS + minute * 60_000), asInt: String(value) }],
            },
          },
        ],
        undefined,
        totals,
      ).points.map((p) => p.value);
    expect(level(0, 7)).toEqual([7]);
    expect(level(1, 4)).toEqual([4]);
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
      { name: "latency.exp", exponentialHistogram: { dataPoints: [{}] } },
      { name: "latency", summary: { dataPoints: [{}] } },
    ]);
    const json = await postJson(mixed);
    expect(await json.json()).toEqual({
      ingested: 2,
      partialSuccess: {
        rejectedDataPoints: "2",
        errorMessage: "exponential histograms: 1 rejected; summaries: 1 rejected",
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

  test("a running total is converted across requests, by the process that takes them", async () => {
    // It started just now, after the process that takes it: all of it is new.
    const started = nano(Date.now());
    const total = (value: number, at: number) =>
      request([
        {
          name: "app.jobs.total",
          sum: {
            aggregationTemporality: CUMULATIVE,
            isMonotonic: true,
            dataPoints: [{ startTimeUnixNano: started, timeUnixNano: nano(at), asInt: String(value) }],
          },
        },
      ]);
    const now = Date.now();
    expect(await (await postJson(total(99, now))).json()).toEqual({ ingested: 1 });
    expect(await (await postJson(total(104, now + 1_000))).json()).toEqual({ ingested: 1 });
    expect(stored.metrics!.map((row) => row.value)).toEqual([99, 5]);
    expect(stored.metric_kinds!.map((row) => [row.name, row.kind])).toEqual([["app.jobs.total", "counter"]]);
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
