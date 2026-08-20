const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Newest-first pages start in a short lookback, then widen to `from`. */
export const eventLookbacksMs = [
  MINUTE_MS,
  4 * MINUTE_MS,
  16 * MINUTE_MS,
  HOUR_MS,
  4 * HOUR_MS,
  DAY_MS,
  7 * DAY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
  365 * DAY_MS,
] as const;

/** Lower `from` bound for a newest-first page: `max(from, upper - lookback)`. */
export function eventSliceFrom(
  fromIso: string | undefined,
  upperIso: string,
  lookbackMs: number,
): string {
  const upper = Date.parse(upperIso);
  const sliced = (Number.isFinite(upper) ? upper : Date.now()) - lookbackMs;
  if (!fromIso) {
    return new Date(sliced).toISOString();
  }
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) {
    return new Date(sliced).toISOString();
  }
  return new Date(Math.max(from, sliced)).toISOString();
}

/** Load-more (`cursor`) already has a histogram; `since` still needs the live bucket. */
export function skipSearchHistogram(filters: {
  cursor?: string;
  since?: string;
}): boolean {
  return Boolean(filters.cursor) && !filters.since;
}

/** `events=0` skips the event page and lookback widening (logs-off widgets). */
export function skipSearchEvents(filters: { events?: string }): boolean {
  return filters.events === "0";
}

export function eventSliceAtFloor(
  fromIso: string | undefined,
  sliceFrom: string,
): boolean {
  if (!fromIso) {
    return false;
  }
  const from = Date.parse(fromIso);
  const slice = Date.parse(sliceFrom);
  if (!Number.isFinite(from) || !Number.isFinite(slice)) {
    return true;
  }
  return slice <= from;
}
