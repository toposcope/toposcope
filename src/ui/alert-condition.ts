import { seriesLabel } from "../query/agg";
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
