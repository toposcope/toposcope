import { describe, expect, test } from "bun:test";
import { planSeries } from "./read";
import { parseShareScope, type ShareScope } from "./scope";

function scope(raw: Record<string, unknown>): ShareScope {
  const parsed = parseShareScope(raw);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed;
}

const agental = scope({
  metric_names: ["fleet_*"],
  metric_labels: "service:agental",
  logs: "service:agental",
  split: ["host", "pool"],
  narrow: ["host"],
});
const window = { range: "24h" };

describe("a series read under a share", () => {
  test("a metric gets the scope's labels and the caller's narrowing; never events", () => {
    expect(planSeries(agental, { metric: "p99:fleet_latency", ml: "host:box-1", split: "pool", window })).toEqual({
      kind: "metric",
      filters: { range: "24h", metric: "p99:fleet_latency", ml: "host:box-1,service:agental", msplit: "pool", events: "0" },
    });
  });

  test("a metric outside the scope reads as one that does not exist", () => {
    expect(planSeries(agental, { metric: "billing_cpu", window })).toEqual({ error: "no such metric", status: 404 });
  });

  test("logs are the scope's q with the narrowing ANDed on, counted or as a rate", () => {
    expect(planSeries(agental, { agg: "rate", ml: "host:box-1", split: "host", window })).toEqual({
      kind: "logs",
      agg: "rate",
      filters: { range: "24h", q: '(service:agental) host:"box-1"', split: "host", agg: "rate", events: "0" },
    });
    expect(planSeries(agental, { window })).toMatchObject({ kind: "logs", agg: "count", filters: { split: "none" } });
  });

  test("refuses what the share does not list", () => {
    expect(planSeries(agental, { agg: "max:account_id", window })).toHaveProperty("status", 400);
    expect(planSeries(agental, { agg: "count", ml: "pool:a", window })).toEqual({
      error: "this share cannot narrow by pool",
      status: 400,
    });
    expect(planSeries(agental, { metric: "fleet_cpu", split: "account_id", window })).toEqual({
      error: "this share cannot split by account_id",
      status: 400,
    });
    expect(planSeries(agental, { agg: "count", split: "pool", window })).toHaveProperty("status", 400);
    expect(planSeries(agental, { metric: "fleet_cpu", agg: "count", window })).toHaveProperty("status", 400);
  });

  test("a share with no logs has none to read", () => {
    const metricsOnly = scope({ metric_names: ["fleet_*"] });
    expect(planSeries(metricsOnly, { agg: "count", window })).toEqual({ error: "this share reads no logs", status: 404 });
  });
});
