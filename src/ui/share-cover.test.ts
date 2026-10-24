import { describe, expect, test } from "bun:test";
import { expiresSoon, limitsLine, scopeLine, type ShareView } from "./share-cover";

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

describe("a share in the list", () => {
  test("scope and limits in one line each; under two weeks is said", () => {
    expect(scopeLine(consoleShare)).toBe("service:agental · fleet_* · logs service:agental");
    expect(scopeLine(share("b", { metric_names: ["http_requests"], metric_labels: "service:billing" }))).toBe("service:billing · http_requests · no logs");
    expect(limitsLine(consoleShare)).toBe("≥1m · ≤30d · back 400d · 300/min · expires 2027-10-23");
    expect(expiresSoon({ ...consoleShare, expires_at: now + 6 * day }, now)).toBe("expires in 6d");
    expect(expiresSoon(consoleShare, now)).toBeNull();
  });
});
