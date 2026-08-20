import { describe, expect, test } from "bun:test";
import {
  formatMetricLabels,
  metricExpr,
  parseMetricLabels,
  parseMetricName,
  parseMetricPoint,
  InvalidMetricError,
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
