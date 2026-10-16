import { seriesLabel } from "../query/agg";
import { facetValues } from "./query-tokens";
import { rangeTriggerLabel } from "./time-range";

export function savedWindowLabel(item: {
  range: string | null;
  from_ts: string | null;
  to_ts: string | null;
}): string {
  if (item.range) {
    return `Last ${item.range}`;
  }
  if (item.from_ts && item.to_ts) {
    return rangeTriggerLabel("custom", item.from_ts, item.to_ts);
  }
  return "this window";
}

export function fireWhenHint(agg: string | null | undefined): string {
  if (!agg) {
    return "matching events in the window";
  }
  if (agg === "rate") {
    return "events per second in the window";
  }
  return `window ${seriesLabel(agg)}`;
}

export function queryPreview(query: string): string {
  const trimmed = query.trim();
  return trimmed.length > 0 ? trimmed : "*";
}

/** "Pages when api p99 slow's p99(duration_ms) over its 15m is at or above 800, then waits 15m before it can page again." */
export function thresholdSentence(
  item: { name: string; agg?: string | null; range: string | null },
  threshold: string,
): string {
  const window = item.range ? `its ${item.range}` : "its window";
  // The cooldown is the saved range, or 5m when the window is custom.
  const wait = item.range ?? "5m";
  return `Pages when ${item.name}’s ${seriesLabel(item.agg ?? null)} over ${window} is at or above ${threshold}, then waits ${wait} before it can page again.`;
}

/** "on service api, or on no service": the marks a first-seen alert watches, as its q scopes them. */
export function firstSeenMarksScope(query: string): string {
  const services = facetValues(query, "service");
  if (services.length === 0) {
    return "on any service";
  }
  return `on service ${services.join(" or ")}, or on no service`;
}
