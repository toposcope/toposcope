import { parseSearchAgg, rateFromHistogram, refusedAgg, windowSeconds } from "../query/agg";
import { histogramIntervalMs } from "../query/histogram";
import { isCoreField } from "../query/compile";
import { applySeriesSearchParams, widgetSeriesQuery } from "../shared/widgets";
import type { BoardPanel } from "../shared/boards";
import { fillHistogram } from "./fill-histogram";
import { histogramTotal, mergeHistogramBuckets, mergeLiveEvents } from "./merge-live";
import { isCountOrRateQuery } from "./live-widget-clock";
import type { FacetValue, Facets, HistogramBucket, LogEvent, SearchAggResult, SearchResult } from "./types";

/** How many rows an events panel reads: enough to fill its tallest cell. */
export const boardEventsLimit = 50;

/** The window a panel reads: a relative range, or both ends. */
export type PanelWindow = { range: string } | { from: string; to: string };

export type PanelData = {
  histogram: HistogramBucket[];
  agg: SearchAggResult | null;
  total: number;
  values?: FacetValue[];
  events?: LogEvent[];
  from: string | null;
  to: string | null;
  fetchedAt: number;
  /** Why the read was refused (the scan budget), or why it failed. */
  refused?: string | null;
  error?: string | null;
};

function windowParams(win: PanelWindow, q: string): URLSearchParams {
  const params = new URLSearchParams();
  if ("range" in win) {
    params.set("range", win.range);
  } else {
    params.set("from", win.from);
    params.set("to", win.to);
  }
  if (q.trim()) {
    params.set("q", q.trim());
  }
  return params;
}

/**
 * Whether a panel's Live 2s poll can ask for only what is new (`since=`) and merge it (#410): a
 * count or rate histogram and the event table. Everything else waits for the 30s whole-window pass.
 */
export function panelMergeable(panel: BoardPanel): boolean {
  if (panel.view === "events") {
    return true;
  }
  if (panel.view !== "histogram") {
    return false;
  }
  return isCountOrRateQuery(widgetSeriesQuery(panel.widget));
}

export async function fetchPanel(
  panel: BoardPanel,
  q: string,
  win: PanelWindow,
  signal: AbortSignal,
  prev?: PanelData | null,
): Promise<PanelData> {
  const params = windowParams(win, q);
  const since = prev && !prev.error && panelMergeable(panel) ? prev.to : null;
  if (panel.view === "events") {
    params.set("limit", String(boardEventsLimit));
  } else {
    params.set("events", "0");
  }
  if (panel.view === "histogram" || panel.view === "stat") {
    applySeriesSearchParams(params, widgetSeriesQuery(panel.widget));
  } else {
    params.set("split", "none");
  }
  if (since) {
    params.set("since", since);
  }
  const res = await fetch(`/api/search?${params.toString()}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { histogram: [], agg: null, total: 0, from: null, to: null, fetchedAt: Date.now(), error: body?.error ?? `Search failed (${res.status})` };
  }
  const json = (await res.json()) as SearchResult;
  const from = json.from ?? json.histogram[0]?.t ?? null;
  const to = json.to ?? null;
  const intervalMs = from && to ? histogramIntervalMs(from, to) : 60_000;
  const merged = since && prev ? mergeHistogramBuckets(prev.histogram, json.histogram) : json.histogram;
  const histogram = from && to ? fillHistogram(from, to, merged, intervalMs) : merged;
  const total = histogramTotal(histogram);
  const refused = json.scan?.source === "refused" ? (json.scan.reason ?? "refused") : null;
  let agg: SearchAggResult | null = json.agg ?? null;
  const parsed = (() => {
    try {
      return parseSearchAgg(panel.widget.agg ?? undefined);
    } catch {
      return null;
    }
  })();
  if (!panel.widget.metric && parsed?.op === "rate" && panel.view !== "top" && panel.view !== "events") {
    agg = json.scan?.histogram ? refusedAgg("rate", json.scan.reason ?? "refused") : rateFromHistogram(histogram, intervalMs / 1000, windowSeconds(from, to));
  }
  const data: PanelData = { histogram, agg, total, from, to, fetchedAt: Date.now(), refused };
  if (panel.view === "events") {
    data.events = since && prev?.events && from ? mergeLiveEvents(prev.events, json.events, from, boardEventsLimit) : json.events;
  }
  if (panel.view === "top") {
    data.values = await fetchTopValues(panel, q, win, total, signal);
  }
  return data;
}

async function fetchTopValues(
  panel: BoardPanel,
  q: string,
  win: PanelWindow,
  total: number,
  signal: AbortSignal,
): Promise<FacetValue[]> {
  const widget = panel.widget;
  if (!widget.attr && widget.split === "none") {
    return [{ v: "events", n: total }];
  }
  const params = windowParams(win, q);
  params.set("limit", String(widget.n));
  params.set("omit", "0");
  if (widget.attr) {
    params.set("attrs", widget.attr);
    const res = await fetch(`/api/attr-facets?${params.toString()}`, { signal });
    if (!res.ok) {
      return [];
    }
    const json = (await res.json()) as Record<string, FacetValue[]>;
    return json[widget.attr] ?? [];
  }
  const res = await fetch(`/api/facets?${params.toString()}`, { signal });
  if (!res.ok) {
    return [];
  }
  const json = (await res.json()) as Facets;
  const field = widget.split as "level" | "service" | "host";
  return json[field] ?? [];
}

/**
 * A field's values on the rows a query matches, from the minute rollups (39c): what an empty
 * panel says about an input. Empty means those rows have no such field in the window.
 */
export async function fetchFieldValues(
  key: string,
  q: string,
  win: PanelWindow,
  signal: AbortSignal,
  limit = 5,
): Promise<FacetValue[]> {
  const params = windowParams(win, q);
  params.set("limit", String(limit));
  params.set("omit", "0");
  if (isCoreField(key)) {
    const res = await fetch(`/api/facets?${params.toString()}`, { signal });
    if (!res.ok) {
      return [];
    }
    const json = (await res.json()) as Record<string, FacetValue[] | undefined>;
    return json[key] ?? [];
  }
  params.set("attrs", key);
  const res = await fetch(`/api/attr-facets?${params.toString()}`, { signal });
  if (!res.ok) {
    return [];
  }
  const json = (await res.json()) as Record<string, FacetValue[]>;
  return json[key] ?? [];
}
