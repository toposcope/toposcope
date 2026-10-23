import { describe, expect, test } from "bun:test";
import { embedTag, expiresSoon, limitsLine, scopeLine, shareCovering, shareMisses, type ShareView } from "./share-cover";

const now = Date.parse("2026-10-23T12:00:00Z");
const day = 86_400_000;

function share(name: string, scope: Partial<ShareView["scope"]>, extra: Partial<ShareView> = {}): ShareView {
  return {
    name,
    scope: { metric_names: [], metric_labels: "", logs: null, split: [], narrow: [], ...scope },
    limits: { min_step: "1m", max_range: "30d", max_lookback: "400d", reads_per_minute: 300 },
    embed: { frame_ancestors: [], ticket_ttl: "1h" },
    expires_at: now + 365 * day,
    revoked_at: null,
    created_at: now,
    ...extra,
  };
}

const consoleShare = share("agental-console", {
  metric_names: ["fleet_*"],
  metric_labels: "service:agental",
  logs: "service:agental",
  split: ["host", "pool"],
  narrow: ["host", "pool"],
});

describe("which share covers a panel", () => {
  test("names, fixed labels, narrowing and splits", () => {
    expect(shareMisses(consoleShare, { metric: "fleet_cpu_seconds", labels: {}, split: "host" })).toBeNull();
    expect(shareMisses(consoleShare, { metric: "p99:fleet_latency", labels: { service: "agental", host: "box-1" }, split: null })).toBeNull();
    expect(shareMisses(consoleShare, { metric: "http_requests", labels: {}, split: null })).toBe("http_requests is not in it");
    expect(shareMisses(consoleShare, { metric: "fleet_cpu", labels: { service: "billing" }, split: null })).toBe("it is fixed to service:agental");
    expect(shareMisses(consoleShare, { metric: "fleet_cpu", labels: { region: "eu" }, split: null })).toBe("it cannot narrow by region");
    expect(shareMisses(consoleShare, { metric: "fleet_cpu", labels: {}, split: "account_id" })).toBe("it cannot split by account_id");
  });

  test("the first live share that covers it; else why; nothing when there are no shares", () => {
    const billing = share("billing-panel", { metric_names: ["http_requests"], metric_labels: "service:billing" });
    expect(shareCovering([billing, consoleShare], { metric: "fleet_cpu", labels: {}, split: null }, now)).toEqual({ share: consoleShare });
    expect(shareCovering([consoleShare], { metric: "http_requests", labels: { service: "billing" }, split: null }, now)).toEqual({
      why: "no share covers http_requests on service:billing",
    });
    expect(shareCovering([], { metric: "fleet_cpu", labels: {}, split: null }, now)).toBeNull();
    const revoked = { ...consoleShare, revoked_at: now - 1 };
    expect(shareCovering([revoked], { metric: "fleet_cpu", labels: {}, split: null }, now)).toBeNull();
  });
});

describe("Copy embed", () => {
  test("a script tag with the panel's params and a TICKET for the backend to fill", () => {
    expect(embedTag("https://logs.example.com", { metric: "fleet_cpu_seconds", labels: { host: "box-1" }, split: null }, { range: "24h", title: 'CPU "all"' })).toBe(
      '<script src="https://logs.example.com/embed.js"\n  data-ticket="TICKET" data-metric="fleet_cpu_seconds" data-ml="host:box-1" data-range="24h" data-title="CPU &quot;all&quot;"></script>',
    );
  });
});

describe("a share in the list", () => {
  test("scope and limits in one line each; under two weeks is said", () => {
    expect(scopeLine(consoleShare)).toBe("service:agental · fleet_* · logs service:agental");
    expect(scopeLine(share("b", { metric_names: ["http_requests"], metric_labels: "service:billing" }))).toBe("service:billing · http_requests · no logs");
    expect(limitsLine(consoleShare)).toBe("≥1m · ≤30d · back 400d · 300/min · expires 2027-10-23");
    expect(expiresSoon({ ...consoleShare, expires_at: now + 6 * day }, now)).toBe("expires in 6d");
    expect(expiresSoon(consoleShare, now)).toBeNull();
  });
});
