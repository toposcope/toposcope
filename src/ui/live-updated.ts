/** Hide while the 2s Live poll is still landing. */
export const liveUpdatedMinAgeMs = 3000;

export function formatLiveUpdatedAge(ageMs: number): string {
  const sec = Math.max(1, Math.round(ageMs / 1000));
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  return `${Math.round(min / 60)}h`;
}

export function liveUpdatedLabel(
  fetchedAt: number | undefined,
  now: number,
): string | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const age = now - fetchedAt;
  if (age < liveUpdatedMinAgeMs) {
    return null;
  }
  return formatLiveUpdatedAge(age);
}

/** Facet chips refresh on the 30s Live pass (frame 36c). */
export const facetRefreshMs = 30_000;
/** Past one pass plus this slack, the age turns plate: a pass was missed (36g). */
export const facetOverdueSlackMs = 5_000;

export type FacetAgeView = { label: string; overdue: boolean; tip: string };

/** The age that leads the chip row in Live (36c, 36f, 36g). */
export function facetAgeView(
  fetchedAt: number | undefined,
  now: number,
  paused: boolean,
): FacetAgeView | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const age = Math.max(0, now - fetchedAt);
  const label = formatLiveUpdatedAge(age);
  return {
    label,
    overdue: !paused && age > facetRefreshMs + facetOverdueSlackMs,
    tip: `Counts refresh every 30s in Live · last ${label} ago · minute rollups, the newest minute lands late`,
  };
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
