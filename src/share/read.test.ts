import { describe, expect, test } from "bun:test";
import { planLatest, planSeries } from "./read";
import { defaultShareLimits } from "./limits";
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

describe("a latest-value read under a share", () => {
  const business = scope({
    metric_names: ["agental.business.*", "agental.funnel.*"],
    metric_labels: "service:agental",
    narrow: ["day", "source", "cohort"],
  });
  const limits = { ...defaultShareLimits, max_range: "7d", max_lookback: "400d" };
  const now = Date.parse("2026-11-19T12:00:00Z");

  test("groups by narrow keys, keeps the scope's labels, and may look back past max_range", () => {
    expect(
      planLatest(business, limits, { metric: "agental.business.sign_ups, agental.business.received_usd", by: "day", lookback: "400d" }, now),
    ).toEqual({
      names: ["agental.business.sign_ups", "agental.business.received_usd"],
      by: ["day"],
      labels: { service: "agental" },
      lookback: "400d",
      from: new Date(now - 400 * 86_400_000).toISOString(),
    });
    expect(
      planLatest(business, limits, { metric: "agental.funnel.paying", by: "source,cohort", ml: "", lookback: "30d" }, now),
    ).toMatchObject({ by: ["source", "cohort"] });
  });

  test("a narrowing is ANDed on; a grouped key cannot also be narrowed", () => {
    expect(planLatest(business, limits, { metric: "agental.funnel.paying", by: "cohort", ml: "source:all", lookback: "30d" }, now)).toMatchObject({
      labels: { source: "all", service: "agental" },
    });
    expect(planLatest(business, limits, { metric: "agental.funnel.paying", by: "cohort", ml: "cohort:all", lookback: "30d" }, now)).toEqual({
      error: "cohort is both grouped by and narrowed",
      status: 400,
    });
  });

  test("the lookback is held to max_lookback", () => {
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", by: "day", lookback: "401d" }, now)).toEqual({
      error: "this share reaches back 400d",
      status: 400,
    });
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", by: "day" }, now)).toHaveProperty("status", 400);
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", by: "day", lookback: "1y" }, now)).toHaveProperty("status", 400);
  });

  test("refuses names outside the scope, readings, and keys that are not narrow keys", () => {
    expect(planLatest(business, limits, { metric: "billing_cpu", by: "day", lookback: "30d" }, now)).toEqual({
      error: "no such metric: billing_cpu",
      status: 404,
    });
    expect(planLatest(business, limits, { metric: "p99:agental.business.x", by: "day", lookback: "30d" }, now)).toHaveProperty("status", 404);
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", by: "account", lookback: "30d" }, now)).toEqual({
      error: "this share cannot group by account: it is not a narrow key",
      status: 400,
    });
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", by: "service", lookback: "30d" }, now)).toHaveProperty("status", 400);
    expect(planLatest(business, limits, { by: "day", lookback: "30d" }, now)).toHaveProperty("status", 400);
    expect(planLatest(business, limits, { metric: "agental.business.sign_ups", lookback: "30d" }, now)).toHaveProperty("status", 400);
    const nine = Array.from({ length: 9 }, (_, i) => `agental.business.m${i}`).join(",");
    expect(planLatest(business, limits, { metric: nine, by: "day", lookback: "30d" }, now)).toHaveProperty("status", 400);
    expect(planLatest(business, limits, { metric: "agental.business.x", by: "day,source,cohort,host", lookback: "30d" }, now)).toHaveProperty("status", 400);
  });
});
