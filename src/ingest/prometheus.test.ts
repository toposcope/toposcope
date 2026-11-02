import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { MetricPoint } from "../shared/metric";
import { BucketAssembler, FamilyTypes, hostOfInstance, mapPrometheusWrite } from "./prometheus";
import { decodeWriteRequest, encodeWriteRequest, type PromSample } from "./prometheus-protobuf";
import { RunningTotals } from "./running-totals";
import { InvalidSnappyError, SnappyTooLargeError, snappyCompressLiterals, snappyDecompress } from "./snappy";

// What a real Prometheus posted with remote write. See fixtures/ingest/README.md.
const fixtures = join(import.meta.dir, "../../fixtures/ingest");
const read = async (file: string) =>
  decodeWriteRequest(snappyDecompress(new Uint8Array(await Bun.file(`${fixtures}/${file}`).arrayBuffer()), 1_000_000));

const STALE = new Float64Array(new BigUint64Array([0x7ff0000000000002n]).buffer)[0]!;

function series(name: string, labels: Record<string, string>, samples: PromSample[]) {
  return {
    labels: [{ name: "__name__", value: name }, ...Object.entries(labels).map(([n, value]) => ({ name: n, value }))],
    samples,
  };
}

function request(timeseries: ReturnType<typeof series>[], metadata: Array<{ type: number; metricFamilyName: string; help?: string }> = []) {
  return decodeWriteRequest(encodeWriteRequest({ timeseries, metadata }));
}

function mapper() {
  const totals = new RunningTotals();
  const types = new FamilyTypes();
  const assembler = new BucketAssembler(30_000);
  return {
    assembler,
    map: (req: ReturnType<typeof request>, nowMs = 1_000) => mapPrometheusWrite(req, totals, types, assembler, nowMs),
  };
}

const values = (points: MetricPoint[], name: string) => points.filter((p) => p.name === name).map((p) => p.value);

describe("snappy", () => {
  test("a literal-only block reads back", () => {
    const text = new TextEncoder().encode("toposcope ".repeat(20_000));
    expect(snappyDecompress(snappyCompressLiterals(text), 1_000_000)).toEqual(text);
  });

  test("a block with copies reads back: Prometheus's own", async () => {
    const raw = new Uint8Array(await Bun.file(`${fixtures}/prometheus/scrape-1.bin`).arrayBuffer());
    const out = snappyDecompress(raw, 1_000_000);
    expect(out.length).toBeGreaterThan(raw.length * 3);
  });

  test("a block that says it is larger than the cap is refused before it is read", () => {
    const big = snappyCompressLiterals(new Uint8Array(2_000));
    expect(() => snappyDecompress(big, 1_000)).toThrow(SnappyTooLargeError);
  });

  test("a truncated block or a copy before the start is refused", () => {
    const ok = snappyCompressLiterals(new TextEncoder().encode("abcdefgh"));
    expect(() => snappyDecompress(ok.subarray(0, ok.length - 2), 100)).toThrow(InvalidSnappyError);
    // Length 4, then a 1-byte-offset copy of 4 with offset 1 and nothing to copy from.
    expect(() => snappyDecompress(Uint8Array.from([4, 0b0000_0001, 1]), 100)).toThrow(InvalidSnappyError);
  });
});

describe("a real Prometheus scraping node_exporter and itself", () => {
  test("metadata comes in a request of its own", async () => {
    const meta = await read("prometheus/metadata.bin");
    expect(meta.timeseries).toHaveLength(0);
    expect(meta.metadata.find((m) => m.family === "node_cpu_seconds_total")?.type).toBe(1);
  });

  test("the second scrape stores counters as amounts, gauges as levels, and a histogram's buckets", async () => {
    const { map, assembler } = mapper();
    map(await read("prometheus/metadata.bin"));
    const first = map(await read("prometheus/scrape-1.bin"));
    // Every running total is a baseline the first time.
    expect(values(first.points, "node_cpu_seconds_total")).toEqual([]);
    expect(first.dropped.baseline).toBeGreaterThan(100);
    expect(values(first.points, "node_memory_memavailable_bytes").length).toBe(1);

    const second = map(await read("prometheus/scrape-2.bin"));
    const cpu = second.points.filter((p) => p.name === "node_cpu_seconds_total");
    expect(cpu.length).toBeGreaterThan(0);
    for (const point of cpu) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThan(10);
      expect(point.labels.service).toBe("node");
      expect(point.labels.host).toBe("node-exporter");
      expect(point.labels.instance).toBe("node-exporter:9100");
      expect(point.labels.cpu).toBeDefined();
    }
    expect(second.kinds.get("node_cpu_seconds_total")).toBe("counter");
    expect(second.kinds.get("node_memory_memavailable_bytes")).toBe("gauge");
    expect(second.descriptions.get("node_memory_memavailable_bytes")).toContain("Memory information");

    // Prometheus's request-duration histogram, scraped from itself.
    expect(second.kinds.get("prometheus_http_request_duration_seconds")).toBe("histogram");
    expect(second.kinds.get("prometheus_http_request_duration_seconds.count")).toBe("counter");
    const buckets = [...second.buckets, ...assembler.take(0, true)].filter((row) => row.name === "prometheus_http_request_duration_seconds");
    const counted = buckets.flatMap((row) => row.n).reduce((a, b) => a + b, 0);
    const count = values(second.points, "prometheus_http_request_duration_seconds.count").reduce((a, b) => a + b, 0);
    expect(counted).toBe(count);
    for (const row of buckets) {
      expect(row.n).toHaveLength(row.le.length + 1);
    }

    // A summary keeps its count and sum; its quantiles are not stored.
    expect(second.dropped.quantiles).toBeGreaterThan(0);
    expect(second.kinds.get("go_gc_duration_seconds.count")).toBe("counter");
    expect(second.points.some((p) => p.name === "go_gc_duration_seconds")).toBe(false);
  });
});

describe("a scrape that Prometheus split across two requests", () => {
  test("the histogram it cut in two is written whole, once, when the next scrape arrives", async () => {
    const { map, assembler } = mapper();
    map(await read("prometheus/metadata.bin"));
    map(await read("prometheus/scrape-1.bin"));
    map(await read("prometheus/scrape-2.bin"));
    assembler.take(0, true);
    const one = map(await read("prometheus/split-1.bin"));
    const two = map(await read("prometheus/split-2.bin"));
    const rest = assembler.take(0, true);
    const name = "prometheus_http_request_duration_seconds";
    const counted = [...one.buckets, ...two.buckets, ...rest].filter((row) => row.name === name).flatMap((row) => row.n).reduce((a, b) => a + b, 0);
    const count = [...values(one.points, `${name}.count`), ...values(two.points, `${name}.count`)].reduce((a, b) => a + b, 0);
    expect(counted).toBe(count);
    const times = [...one.buckets, ...two.buckets, ...rest].filter((row) => row.name === name).map((row) => `${row.ts} ${JSON.stringify(row.labels)}`);
    expect(new Set(times).size).toBe(times.length);
  });
});

describe("mapping", () => {
  test("a counter's running total becomes the amount per scrape, and a reset counts whole", () => {
    const { map } = mapper();
    const at = (value: number, timestamp: number) => request([series("http_requests_total", { job: "api", instance: "10.0.0.5:8080" }, [{ value, timestamp }])]);
    expect(map(at(100, 1_000)).points).toEqual([]);
    expect(values(map(at(130, 16_000)).points, "http_requests_total")).toEqual([30]);
    expect(values(map(at(5, 31_000)).points, "http_requests_total")).toEqual([5]);
    // The same sample again, as a retry sends it, adds nothing.
    expect(map(at(5, 31_000)).points).toEqual([]);
  });

  test("job is service and instance's host part is host, unless the series has its own", () => {
    const { map } = mapper();
    const out = map(request([
      series("up", { job: "api", instance: "10.0.0.5:8080" }, [{ value: 1, timestamp: 1_000 }]),
      series("up", { job: "db", instance: "db-1:9187", service: "postgres", host: "db-1.internal" }, [{ value: 1, timestamp: 1_000 }]),
    ]));
    expect(out.points.map((p) => [p.labels.service, p.labels.host, p.labels.job])).toEqual([
      ["api", "10.0.0.5", "api"],
      ["postgres", "db-1.internal", "db"],
    ]);
    expect(hostOfInstance("[::1]:9100")).toBe("::1");
    expect(hostOfInstance("::1")).toBe("::1");
    expect(hostOfInstance("node")).toBe("node");
  });

  test("a stale marker and NaN are not stored", () => {
    const { map } = mapper();
    const out = map(request([series("queue_depth", {}, [{ value: STALE, timestamp: 1_000 }, { value: Number.NaN, timestamp: 2_000 }, { value: 3, timestamp: 3_000 }])]));
    expect(values(out.points, "queue_depth")).toEqual([3]);
    expect(out.dropped.notANumber).toBe(2);
  });

  test("metadata that says gauge wins over a reserved suffix", () => {
    const { map } = mapper();
    const meta = [{ type: 2, metricFamilyName: "items_total" }];
    const out = map(request([series("items_total", {}, [{ value: 7, timestamp: 1_000 }])], meta));
    expect(values(out.points, "items_total")).toEqual([7]);
    expect(out.kinds.get("items_total")).toBe("gauge");
  });

  test("help that is only the family's name, as Vector sends it, is not a description", () => {
    const { map } = mapper();
    const out = map(request([series("queue_depth", {}, [{ value: 1, timestamp: 1_000 }])], [{ type: 2, metricFamilyName: "queue_depth", help: "queue_depth" }]));
    expect(out.descriptions.has("queue_depth")).toBe(false);
  });

  test("metadata that says counter makes a name with no suffix a counter", () => {
    const { map } = mapper();
    const meta = [{ type: 1, metricFamilyName: "jobs_done" }];
    map(request([series("jobs_done", {}, [{ value: 10, timestamp: 1_000 }])], meta));
    const out = map(request([series("jobs_done", {}, [{ value: 12, timestamp: 2_000 }])]));
    expect(values(out.points, "jobs_done")).toEqual([2]);
    expect(out.kinds.get("jobs_done")).toBe("counter");
  });

  test("a histogram split across requests is written whole when its next scrape arrives", () => {
    const { map, assembler } = mapper();
    const bucket = (le: string, value: number, timestamp: number) => series("rpc_seconds_bucket", { job: "api", le }, [{ value, timestamp }]);
    const scrape = (t: number, upTo: [number, number, number]) => [
      request([bucket("0.1", upTo[0], t), bucket("0.5", upTo[1], t)]),
      request([bucket("+Inf", upTo[2], t), series("rpc_seconds_count", { job: "api" }, [{ value: upTo[2], timestamp: t }])]),
    ];
    for (const req of scrape(1_000, [10, 15, 20])) map(req);
    const [a, b] = scrape(16_000, [14, 22, 30]);
    expect(map(a!).buckets).toEqual([]);
    const second = map(b!);
    expect(values(second.points, "rpc_seconds.count")).toEqual([10]);
    expect(assembler.size).toBe(1);
    // The scrape after that makes the one before it whole.
    const [c] = scrape(31_000, [14, 22, 30]);
    const whole = map(c!).buckets;
    expect(whole).toHaveLength(1);
    // Up to 0.1: 4. Between 0.1 and 0.5: 7 − 4. Above 0.5: 10 − 7.
    expect(whole[0]).toMatchObject({ name: "rpc_seconds", le: [0.1, 0.5], n: [4, 3, 3], labels: { job: "api", service: "api" } });
  });

  test("buckets that wait past their time are taken", () => {
    const assembler = new BucketAssembler(30_000);
    assembler.add("s", "h", {}, "t1", 1, 3, 0);
    expect(assembler.take(29_999)).toEqual([]);
    expect(assembler.take(30_000)).toHaveLength(1);
    expect(assembler.size).toBe(0);
  });

  test("a recording rule's name, with a colon, cannot be stored", () => {
    const { map } = mapper();
    const out = map(request([series("job:http_requests:rate5m", {}, [{ value: 1, timestamp: 1_000 }])]));
    expect(out.points).toEqual([]);
    expect(out.dropped.badName).toBe(1);
  });
});
