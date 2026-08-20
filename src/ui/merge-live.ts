import { eventKey } from "./event-key";
import type { HistogramBucket, LogEvent } from "./types";

export const livePageSize = 100;

export function mergeLiveEvents(
  prev: LogEvent[],
  incoming: LogEvent[],
  fromIso: string,
  limit = livePageSize,
): LogEvent[] {
  const seen = new Set(incoming.map(eventKey));
  const kept = prev.filter(
    (event) => !seen.has(eventKey(event)) && event.ts >= fromIso,
  );
  const merged = [...incoming, ...kept].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  );
  // Load more grows the list past the live page; only the moving window trims it.
  if (prev.length > limit) {
    return merged;
  }
  return merged.slice(0, limit);
}

export function mergeHistogramBuckets(
  prev: HistogramBucket[],
  incoming: HistogramBucket[],
): HistogramBucket[] {
  if (incoming.length === 0) {
    return prev;
  }
  const byT = new Map(prev.map((bucket) => [bucket.t, bucket]));
  for (const bucket of incoming) {
    byT.set(bucket.t, bucket);
  }
  return [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
}

export function histogramTotal(buckets: HistogramBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.n, 0);
}
