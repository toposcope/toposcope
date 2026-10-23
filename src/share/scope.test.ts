import { describe, expect, test } from "bun:test";
import {
  logQueryFor,
  metricAllowed,
  metricLabelsFor,
  parseNarrowing,
  parseShareScope,
  type ShareScope,
} from "./scope";

const agental = {
  metric_names: ["fleet_*", "sandbox_starts"],
  metric_labels: "service:agental",
  logs: "service:agental",
  split: ["host", "pool"],
  narrow: "host pool",
};

function scope(raw: Record<string, unknown> = agental): ShareScope {
  const parsed = parseShareScope(raw);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed;
}

describe("share scope", () => {
  test("parses names, labels, logs, split and narrow", () => {
    expect(scope()).toEqual({
      metric_names: ["fleet_*", "sandbox_starts"],
      metric_labels: { service: "agental" },
      logs: "service:agental",
      split: ["host", "pool"],
      narrow: ["host", "pool"],
    });
  });

  test("reads metrics, logs or both, never nothing", () => {
    expect(parseShareScope({ metric_names: [] })).toEqual({
      error: "a share reads metrics, logs or both: give metric_names or logs",
    });
    expect(scope({ logs: "service:api" }).metric_names).toEqual([]);
    expect(scope({ metric_names: "cpu" }).logs).toBeNull();
  });

  test("refuses what it cannot hold", () => {
    expect(parseShareScope({ metric_names: ["fleet cpu"] })).toHaveProperty("error");
    expect(parseShareScope({ metric_names: ["cpu"], metric_labels: "service>api" })).toHaveProperty("error");
    expect(parseShareScope({ logs: "(service:api" })).toHaveProperty("error");
    expect(parseShareScope({ logs: "service:api", split: ["a b"] })).toHaveProperty("error");
    expect(parseShareScope({ metric_names: ["cpu"], metric_labels: "service:api", narrow: ["service"] })).toEqual({
      error: "narrow: service is fixed by metric_labels",
    });
  });

  test("a name is inside by exact match or prefix glob", () => {
    const s = scope();
    expect(metricAllowed(s, "fleet_cpu_seconds")).toBe(true);
    expect(metricAllowed(s, "sandbox_starts")).toBe(true);
    expect(metricAllowed(s, "sandbox_starts_total")).toBe(false);
    expect(metricAllowed(s, "billing_cpu")).toBe(false);
  });
});

describe("a caller's narrowing", () => {
  test("only on narrow keys, one value each", () => {
    const s = scope();
    expect(parseNarrowing(s, "host:box-1")).toEqual({ host: "box-1" });
    expect(parseNarrowing(s, "")).toEqual({});
    expect(parseNarrowing(s, "account_id:123")).toEqual({ error: "this share cannot narrow by account_id" });
    expect(parseNarrowing(s, "host:a,host:b")).toEqual({ error: "host is given twice" });
    expect(parseNarrowing(s, 'host:"a')).toHaveProperty("error");
  });

  test("never replaces a scope label", () => {
    const s = scope();
    expect(metricLabelsFor(s, { host: "box-1" })).toEqual({ host: "box-1", service: "agental" });
  });

  test("ANDs onto the scope's q as one exact value, never a glob", () => {
    const s = scope();
    expect(logQueryFor(s, {})).toBe("service:agental");
    expect(logQueryFor(s, { host: "box*" })).toBe('(service:agental) host:"box*"');
    expect(logQueryFor(scope({ metric_names: ["cpu"] }), {})).toBeNull();
  });
});
