import { describe, expect, test } from "bun:test";
import {
  formatMetricLabels,
  metricExpr,
  parseMetricLabels,
  parseMetricName,
  parseMetricPoint,
  InvalidMetricError,
  formatMetricRef,
  normalizeMetricRef,
  parseMetricRef,
} from "./metric";

describe("parseMetricName / labels", () => {
  test("accepts idents and drops junk", () => {
    expect(parseMetricName("cpu_seconds")).toBe("cpu_seconds");
    expect(parseMetricName("CPU_Seconds")).toBe("cpu_seconds");
    expect(parseMetricName("foo-bar")).toBeNull();
    expect(parseMetricName("")).toBeNull();
  });

  test("parses equality matchers including service/host", () => {
    expect(parseMetricLabels("service:api,host:api-1")).toEqual({
      service: "api",
      host: "api-1",
    });
    expect(formatMetricLabels({ service: "api", host: "api-1" })).toBe(
      "host:api-1,service:api",
    );
    expect(metricExpr("cpu_seconds", { service: "api" })).toBe(
      "cpu_seconds{service=api}",
    );
  });
});

describe("parseMetricPoint", () => {
  test("stamps ts and flattens labels", () => {
    const point = parseMetricPoint({
      name: "cpu_seconds",
      value: 0.5,
      labels: { service: "api" },
    });
    expect(point.name).toBe("cpu_seconds");
    expect(point.value).toBe(0.5);
    expect(point.labels).toEqual({ service: "api" });
    expect(Date.parse(point.ts)).not.toBeNaN();
  });

  test("rejects a non-finite value", () => {
    expect(() => parseMetricPoint({ name: "cpu_seconds", value: "x" })).toThrow(
      InvalidMetricError,
    );
  });
});

describe("a metric with a histogram's reading in front", () => {
  test("a bare name has no reading", () => {
    expect(parseMetricRef("http.server.request.duration")).toEqual({
      name: "http.server.request.duration",
      reading: null,
    });
  });

  test("a reading rides in front of the name, and round-trips", () => {
    expect(parseMetricRef("p90:http.server.request.duration")).toEqual({
      name: "http.server.request.duration",
      reading: "p90",
    });
    for (const ref of ["count:latency", "sum:latency", "avg:latency", "p50:latency", "p90:latency", "p99:latency"]) {
      expect(formatMetricRef(parseMetricRef(ref)!)).toBe(ref);
    }
    expect(normalizeMetricRef(" P99:HTTP.Server.Duration ")).toBe("p99:http.server.duration");
  });

  test("a word that is not a reading, or a name that cannot be stored, is not a metric", () => {
    expect(parseMetricRef("max:latency")).toBeNull();
    expect(parseMetricRef("p99:")).toBeNull();
    expect(parseMetricRef(":latency")).toBeNull();
    expect(parseMetricRef("p99:bad name")).toBeNull();
    expect(normalizeMetricRef(null)).toBeNull();
  });

  test("the reading is part of how the series is named", () => {
    expect(metricExpr("latency", { service: "api" }, "p99")).toBe("p99:latency{service=api}");
    expect(metricExpr("latency", {}, "count")).toBe("count:latency");
  });
});
