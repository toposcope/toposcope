import type { SavedSearch } from "./types";

/** A saved search's series as its run reads it. */
export type AlertSeriesView = {
  value: number;
  refused: boolean;
};

/** A board has no count of its own: its inputs are unset until it is opened (#126). */
export function savedCountTargets(searches: readonly SavedSearch[]): SavedSearch[] {
  return searches.filter((item) => !item.board);
}

/**
 * Each plain saved search's count, and its series for the Alerts list, from its run. A run that
 * fails leaves no count — the badge's dash — rather than a 0 that reads as an empty search.
 */
export async function loadSavedCounts(
  searches: readonly SavedSearch[],
  fetchRun: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<{ counts: Record<string, number>; series: Record<string, AlertSeriesView> }> {
  const counts: Record<string, number> = {};
  const series: Record<string, AlertSeriesView> = {};
  await Promise.all(
    savedCountTargets(searches).map(async (item) => {
      try {
        const res = await fetchRun(`/api/saved-searches/${item.id}/run`);
        if (!res.ok) {
          return;
        }
        const json = (await res.json()) as { count: number; value?: number; refused?: boolean };
        counts[item.id] = json.count;
        series[item.id] = {
          value: typeof json.value === "number" ? json.value : json.count,
          refused: Boolean(json.refused),
        };
      } catch {
        // No count: the dash stays.
      }
    }),
  );
  return { counts, series };
}
