import { formatDuration } from "../shared/duration";
/** Hide while the 2s Live poll is still landing. */
export const liveUpdatedMinAgeMs = 3000;

/** Past one 30s pass plus slack, an age turns plate: a pass was missed (36g, sheet 45). */
export const liveLateMs = 35_000;

export type LiveAgeView = { label: string; late: boolean };

/**
 * A Live paint's age (sheet 45 `<LiveAge>`): hidden until `minAgeMs` (a missed 2s poll by
 * default; the facet row shows it from the first second), late past 35s unless Live is paused.
 */
export function liveAgeView(
  fetchedAt: number | undefined,
  now: number,
  opts: { minAgeMs?: number; paused?: boolean } = {},
): LiveAgeView | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const age = Math.max(0, now - fetchedAt);
  if (age < (opts.minAgeMs ?? liveUpdatedMinAgeMs)) {
    return null;
  }
  return { label: formatDuration(age, "short", { least: "s" }), late: !opts.paused && age > liveLateMs };
}

/** The facet row's hover text (36c): its cadence, its age, and why the newest minute lags. */
export function facetAgeTip(label: string): string {
  return `Counts refresh every 30s in Live · last ${label} ago · minute rollups, the newest minute lands late`;
}

/** The chip row's age is its oldest list: core facets or pinned attr facets. */
export function oldestFetchedAt(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length === 0 ? undefined : Math.min(...known);
}

/**
 * A failed chip refresh keeps last paint when it asked for the hunt already on screen
 * (the age then says how old it is, 36g); a new hunt's failure clears the stale chips.
 */
export function blankOnFailedRefresh(failedQuery: string, landedQuery: string | null): boolean {
  return failedQuery !== landedQuery;
}
