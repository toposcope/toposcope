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
 * while open, and says when it resolved." Fewer than: "… is fewer than 1, …" (#176).
 */
export function monitorSentence(
  item: { name: string; agg?: string | null; range: string | null },
  threshold: string,
  remind: "off" | "window" | "1h" | "4h" | "24h",
  opensWhen: "at_least" | "fewer_than" = "at_least",
): string {
  const window = item.range ? `its ${item.range}` : "its window";
  const series = item.agg ? seriesLabel(item.agg) : "count";
  // Every window is the saved range, or 5m when the window is custom.
  const reminds =
    remind === "off" ? "does not remind" : `reminds every ${remind === "window" ? (item.range ?? "5m") : remind} while open`;
  const compare = opensWhen === "fewer_than" ? "fewer than" : "at or above";
  return `Opens when ${item.name}’s ${series} over ${window} is ${compare} ${threshold}, ${reminds}, and says when it resolved.`;
}

/** "on service api, or on no service": the marks a first-seen alert watches, as its q scopes them. */
export function firstSeenMarksScope(query: string): string {
  const services = facetValues(query, "service");
  if (services.length === 0) {
    return "on any service";
  }
  return `on service ${services.join(" or ")}, or on no service`;
}

/** What the editor's Send a test call sends: the draft as it stands, or null while it cannot be sent. */
export function monitorTestDraft(d: {
  id?: string;
  name: string;
  kind: "threshold" | "first_seen";
  savedSearchId: string;
  threshold: number;
  thresholdOk: boolean;
  opensWhen: "at_least" | "fewer_than";
  webhook: string;
  bodyKind: "default" | "text" | "json";
  bodyTemplate: string;
  resolvedBody: string;
  /** A body or search problem that the server would refuse. */
  problem: boolean;
}): Record<string, unknown> | null {
  if (!d.savedSearchId || !d.thresholdOk || d.problem || !/^https?:\/\//.test(d.webhook.trim())) {
    return null;
  }
  return {
    id: d.id,
    name: d.name.trim(),
    kind: d.kind,
    saved_search_id: d.savedSearchId,
    threshold: d.threshold,
    opens_when: d.kind === "first_seen" ? "at_least" : d.opensWhen,
    webhook_url: d.webhook.trim(),
    body_kind: d.bodyKind,
    body_template: d.bodyTemplate,
    // 18t: with a resolved body, the test sends that one too.
    ...(d.kind === "threshold" && d.bodyKind !== "default" && d.resolvedBody.trim() ? { resolved_body: d.resolvedBody } : {}),
  };
}
