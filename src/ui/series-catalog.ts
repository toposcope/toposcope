import { createContext, useContext } from "react";
import type { MetricEntry, MetricKindName } from "./series-list";

/** What the Series control can offer in this window. One per Search view. */
export type SeriesCatalog = {
  /** Every numeric log field seen in the window, busiest first. */
  numericKeys: string[];
  /** Metrics with points in the window, busiest first, as far as they were loaded. */
  metrics: MetricEntry[];
  /** How many metric names have points in the window. */
  metricTotal: number;
  /** The metrics cards already hold, points or no points. */
  picked: Record<string, MetricEntry>;
  /** "1h" for a relative window; empty for a custom one. */
  window: string;
  live: boolean;
  /** Asks the server for names beyond the ones loaded. */
  find: (q: string) => Promise<MetricEntry[]>;
};

export const emptySeriesCatalog: SeriesCatalog = {
  numericKeys: [],
  metrics: [],
  metricTotal: 0,
  picked: {},
  window: "",
  live: false,
  find: async () => [],
};

export const SeriesCatalogContext = createContext<SeriesCatalog>(emptySeriesCatalog);

export function useSeriesCatalog(): SeriesCatalog {
  return useContext(SeriesCatalogContext);
}

/**
 * The picked metric as this window has it, or what is known of it when it has
 * no points here. What was asked about by name comes first: it also says when
 * an older link's `.count` is a reading of a histogram.
 */
export function pickedEntry(
  catalog: SeriesCatalog,
  name: string | null,
  fallbackKind?: MetricKindName,
): MetricEntry | null {
  if (!name) {
    return null;
  }
  return (
    catalog.picked[name] ??
    catalog.metrics.find((metric) => metric.name === name) ??
    (fallbackKind ? { name, kind: fallbackKind, points: 0 } : null)
  );
}
