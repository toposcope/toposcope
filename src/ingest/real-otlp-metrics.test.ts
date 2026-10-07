import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { MetricPoint } from "../shared/metric";
import { mapOtlpMetrics } from "./otlp-metrics";
import { decodeOtlpMetricsProtobuf } from "./otlp-metrics-protobuf";
import { Losses } from "./otlp-reply";
import { RunningTotals } from "./running-totals";

// What a real exporter posted to /v1/metrics. See fixtures/ingest/README.md.
const fixtures = join(import.meta.dir, "../../fixtures/ingest");
const versions = (await Bun.file(`${fixtures}/versions.json`).json()) as {
  metrics: { node: { served: number; requests: { protobuf: string; json: string; stock: string } } };
};
const source = versions.metrics.node;
const bytes = async (file: string) =>
  new Uint8Array(await Bun.file(`${fixtures}/otlp/${file}`).arrayBuffer());

/** The capture is from 2026-10-07. A process that booted in 2020 was up before the service started. */
const upBeforeTheService = () => new RunningTotals(Date.UTC(2020, 0, 1));
/** One that booted a second ago was not: the service was already running. */
const justBooted = () => new RunningTotals(Date.now() - 1_000);

async function read(file: string, totals = upBeforeTheService()) {
  const buf = await bytes(file);
  const payload = file.endsWith(".bin")
    ? decodeOtlpMetricsProtobuf(buf)
    : JSON.parse(new TextDecoder().decode(buf));
  const losses = new Losses();
  const { points, kinds } = mapOtlpMetrics(payload, losses, totals);
  return { points, kinds, losses };
}

const total = (points: MetricPoint[], name: string) =>
  points.filter((point) => point.name === name).reduce((sum, point) => sum + point.value, 0);

describe("a real exporter with the delta setting", () => {
  test.each(["protobuf", "json"] as const)("%s: every point is stored and nothing is refused", async (encoding) => {
    const { points, losses } = await read(source.requests[encoding]);
    expect(points.length).toBeGreaterThan(50);
    expect(losses.message()).toBe("");
  });

  test.each(["protobuf", "json"] as const)(
    "%s: the request-duration histogram's count is the requests the service served",
    async (encoding) => {
      const { points, kinds } = await read(source.requests[encoding]);
      expect(total(points, "http.server.request.duration.count")).toBe(source.served);
      expect(total(points, "http.server.request.duration.sum")).toBeGreaterThan(0);
      expect(kinds.get("http.server.request.duration.count")).toBe("counter");
      expect(kinds.get("http.server.request.duration.sum")).toBe("counter");
    },
  );

  test.each(["protobuf", "json"] as const)("%s: one of each kind lands as its kind", async (encoding) => {
    const { points, kinds } = await read(source.requests[encoding]);
    expect(kinds.get("app.jobs.processed")).toBe("counter");
    expect(total(points, "app.jobs.processed")).toBe(source.served);
    // An up-down counter is still a running total under the delta setting: a level.
    expect(kinds.get("app.requests.in_flight")).toBe("gauge");
    expect(kinds.get("app.memory.heap_used")).toBe("gauge");
    expect(total(points, "app.memory.heap_used")).toBeGreaterThan(1_000_000);
    expect(kinds.get("v8js.memory.heap.used")).toBe("gauge");
  });

  test("protobuf and JSON carry the same names and kinds", async () => {
    const protobuf = await read(source.requests.protobuf);
    const json = await read(source.requests.json);
    expect([...protobuf.kinds].sort()).toEqual([...json.kinds].sort());
  });

  test("a point is labelled with its own attributes, then the service, then the rest of the resource", async () => {
    const { points } = await read(source.requests.json);
    const point = points.find((p) => p.name === "app.jobs.processed")!;
    expect(Object.keys(point.labels).slice(0, 3)).toEqual(["queue", "service.version", "service"]);
    expect(point.labels).toMatchObject({ queue: "charges", service: "billing", "service.version": "1.4.2" });
    expect(point.labels["service.name"]).toBeUndefined();
  });
});

describe("the same exporter with no setting, as a stock setup sends", () => {
  test("its counters and histograms are running totals, and are stored as amounts all the same", async () => {
    const { points, kinds, losses } = await read(source.requests.stock);
    expect(losses.message()).toBe("");
    // The service started after this process did, so its first totals are all new.
    expect(total(points, "http.server.request.duration.count")).toBe(source.served);
    expect(total(points, "app.jobs.processed")).toBe(source.served);
    expect(kinds.get("http.server.request.duration.count")).toBe("counter");
    expect(kinds.get("app.jobs.processed")).toBe("counter");
    expect(kinds.get("app.requests.in_flight")).toBe("gauge");
    expect(total(points, "app.memory.heap_used")).toBeGreaterThan(1_000_000);
  });

  test("it names the same metrics as the delta setting does", async () => {
    const stock = await read(source.requests.stock);
    const delta = await read(source.requests.json);
    expect([...stock.kinds].sort()).toEqual([...delta.kinds].sort());
  });

  test("seen by a process that started after the service did, the first totals are only a baseline", async () => {
    const { points, kinds, losses } = await read(source.requests.stock, justBooted());
    expect(losses.rejectedCount).toBe(0);
    expect(losses.message()).toBe(
      "running totals seen for the first time from a series that was already running, taken as its baseline: 9",
    );
    expect(total(points, "http.server.request.duration.count")).toBe(0);
    expect(new Set(kinds.values())).toEqual(new Set(["gauge"]));
    expect(total(points, "app.memory.heap_used")).toBeGreaterThan(1_000_000);
  });
});
