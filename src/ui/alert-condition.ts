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

/**
 * "Opens when api p99 slow's p99(duration_ms) over its 15m is at or above 800, reminds every 4h
 * while open, and says when it resolved."
 */
export function monitorSentence(
  item: { name: string; agg?: string | null; range: string | null },
  threshold: string,
  remind: "off" | "window" | "1h" | "4h" | "24h",
): string {
  const window = item.range ? `its ${item.range}` : "its window";
  const series = item.agg ? seriesLabel(item.agg) : "count";
  // Every window is the saved range, or 5m when the window is custom.
  const reminds =
    remind === "off" ? "does not remind" : `reminds every ${remind === "window" ? (item.range ?? "5m") : remind} while open`;
  return `Opens when ${item.name}’s ${series} over ${window} is at or above ${threshold}, ${reminds}, and says when it resolved.`;
}

/** "on service api, or on no service": the marks a first-seen alert watches, as its q scopes them. */
export function firstSeenMarksScope(query: string): string {
  const services = facetValues(query, "service");
  if (services.length === 0) {
    return "on any service";
  }
  return `on service ${services.join(" or ")}, or on no service`;
}
