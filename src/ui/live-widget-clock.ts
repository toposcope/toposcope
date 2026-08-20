import {
  mergeAggBuckets,
  parseSearchAgg,
  rateFromHistogram,
  windowSeconds,
  type SearchAgg,
  type SearchAggResult,
} from "../query/agg";
import { compileQuery } from "../query/compile";
import { minuteHistogramMs, rollupSource, type HistogramSplit } from "../query/histogram";
import { skipKeysFromRoles, type FieldRole } from "../shared/fields";
import { levels, type LogLevel } from "../shared/log-event";
import {
  facetSeriesKey,
  seriesQueryKey,
  widgetSeriesQuery,
  type SeriesQuery,
  type WidgetDef,
} from "../shared/widgets";
import { fillHistogram } from "./fill-histogram";
import { histogramTotal, mergeHistogramBuckets } from "./merge-live";
import type { FacetValue, HistogramBucket } from "./types";

export type LiveSeriesData = {
  histogram: HistogramBucket[];
  agg: SearchAggResult | null;
  total: number;
  values?: FacetValue[];
  fetchedAt?: number;
};

export function skipKeysFromFieldRoles(
  roles: Record<string, FieldRole>,
): string[] {
  return skipKeysFromRoles(roles);
}

export function isCountOrRateQuery(query: SeriesQuery): boolean {
  if (query.metric) {
    return false;
  }
  return query.agg === null || query.agg === "count" || query.agg === "rate";
}

function labeledMetric(query: SeriesQuery): boolean {
  return Boolean(query.metric) && Object.keys(query.metricLabels).length > 0;
}

function nonAssociativeAgg(query: SeriesQuery): boolean {
  if (query.metric) {
    return true;
  }
  try {
    const parsed = parseSearchAgg(query.agg ?? undefined);
    return parsed?.op === "p99" || parsed?.op === "avg";
  } catch {
    return false;
  }
}

function widgetsUsingQuery(
  widgets: WidgetDef[],
  query: SeriesQuery,
): WidgetDef[] {
  const key = seriesQueryKey(query);
  return widgets.filter(
    (widget) => seriesQueryKey(widgetSeriesQuery(widget)) === key,
  );
}

export function queryLiveMergeable(
  query: SeriesQuery,
  q: string,
  skipKeys: Iterable<string>,
  widgets: WidgetDef[],
  intervalMs?: number,
): boolean {
  if (
    intervalMs !== undefined &&
    intervalMs < minuteHistogramMs &&
    !isCountOrRateQuery(query) &&
    !query.metric
  ) {
    return false;
  }
  if (labeledMetric(query)) {
    return false;
  }
  if (rollupSource(compileQuery(q), skipKeys) === "logs") {
    return false;
  }
  if (
    nonAssociativeAgg(query) &&
    widgetsUsingQuery(widgets, query).some((widget) => widget.kind === "stat")
  ) {
    return false;
  }
  return true;
}

/** Extra `/api/search` (30s full window, or 2s when also mergeable). */
export function extraQueryNeedsSearch(
  query: SeriesQuery,
  widgets: WidgetDef[],
  primarySplit: HistogramSplit,
): boolean {
  const users = widgetsUsingQuery(widgets, query);
  if (users.length === 0) {
    return false;
  }
  if (isCountOrRateQuery(query) && !query.metric) {
    if (query.split === primarySplit) {
      return false;
    }
    if (!users.some((widget) => widget.kind === "timeseries")) {
      return false;
    }
  }
  return true;
}

/** 2s network fetch for this extra series (not a local projection). */
export function extraQueryLiveFetch(
  query: SeriesQuery,
  widgets: WidgetDef[],
  q: string,
  skipKeys: Iterable<string>,
  primarySplit: HistogramSplit,
  intervalMs?: number,
): boolean {
  return (
    extraQueryNeedsSearch(query, widgets, primarySplit) &&
    queryLiveMergeable(query, q, skipKeys, widgets, intervalMs)
  );
}

export function mergeIncrementalExtraSeries(
  prev: LiveSeriesData | undefined,
  incoming: {
    histogram: HistogramBucket[];
    agg: SearchAggResult | null;
  },
  query: SeriesQuery,
  histFrom: string | undefined,
  histTo: string | undefined,
  intervalMs: number,
): Omit<LiveSeriesData, "fetchedAt"> {
  const mergedHist = mergeHistogramBuckets(
    prev?.histogram ?? [],
    incoming.histogram,
  );
  const extraFilled =
    histFrom && histTo
      ? fillHistogram(histFrom, histTo, mergedHist, intervalMs)
      : mergedHist;
  let extraParsed: SearchAgg | null = null;
  try {
    extraParsed = parseSearchAgg(query.agg ?? undefined);
  } catch {
    extraParsed = null;
  }
  let extraAgg: SearchAggResult | null = incoming.agg;
  if (query.metric) {
    const buckets = mergeAggBuckets(
      prev?.agg?.buckets ?? [],
      incoming.agg?.buckets ?? [],
    );
    const base = incoming.agg ?? prev?.agg ?? null;
    extraAgg = base
      ? { ...base, buckets, stat: prev?.agg?.stat ?? base.stat }
      : null;
  } else if (extraParsed?.op === "rate") {
    extraAgg = rateFromHistogram(
      extraFilled,
      intervalMs / 1000,
      windowSeconds(histFrom, histTo),
    );
  } else if (extraParsed && incoming.agg) {
    const buckets = mergeAggBuckets(
      prev?.agg?.buckets ?? [],
      incoming.agg.buckets,
    );
    extraAgg = {
      ...incoming.agg,
      buckets,
      stat:
        associativeWindowStat(extraParsed, buckets) ??
        prev?.agg?.stat ??
        incoming.agg.stat,
    };
  }
  return {
    histogram: extraFilled,
    agg: extraAgg,
    total: histogramTotal(extraFilled),
  };
}

export function associativeWindowStat(
  parsed: SearchAgg | null,
  buckets: Array<{ v: number }>,
): number | null {
  if (
    !parsed ||
    parsed.op === "rate" ||
    parsed.op === "p99" ||
    parsed.op === "avg"
  ) {
    return null;
  }
  const vs = buckets.map((bucket) => bucket.v).filter((v) => Number.isFinite(v));
  if (vs.length === 0) {
    return null;
  }
  if (parsed.op === "min") {
    return Math.min(...vs);
  }
  if (parsed.op === "max") {
    return Math.max(...vs);
  }
  return vs.reduce((sum, v) => sum + v, 0);
}

export function levelFacetValuesFromHistogram(
  buckets: HistogramBucket[],
): FacetValue[] {
  const counts: Record<LogLevel, number> = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  };
  for (const bucket of buckets) {
    for (const level of levels) {
      counts[level] += bucket.by_level[level] ?? 0;
    }
  }
  return levels
    .map((v) => ({ v, n: counts[v] }))
    .filter((row) => row.n > 0)
    .sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
}

export function deriveLiveSeries(
  widgets: WidgetDef[],
  primary: LiveSeriesData,
  primarySplit: HistogramSplit,
  histFrom: string | undefined,
  histTo: string | undefined,
  intervalMs: number,
  stamp: (data: Omit<LiveSeriesData, "fetchedAt">) => LiveSeriesData,
): Record<string, LiveSeriesData> {
  const out: Record<string, LiveSeriesData> = {};
  const rate = rateFromHistogram(
    primary.histogram,
    intervalMs / 1000,
    windowSeconds(histFrom, histTo),
  );
  for (const widget of widgets) {
    if (widget.kind === "stat" || widget.kind === "timeseries") {
      const query = widgetSeriesQuery(widget);
      if (!isCountOrRateQuery(query) || query.metric) {
        continue;
      }
      if (extraQueryNeedsSearch(query, widgets, primarySplit)) {
        continue;
      }
      out[seriesQueryKey(query)] = stamp({
        histogram: primary.histogram,
        agg: query.agg === "rate" ? rate : null,
        total: primary.total,
      });
      continue;
    }
    if (widget.kind !== "hbar") {
      continue;
    }
    if (widget.attr) {
      continue;
    }
    if (widget.split === "none") {
      out[facetSeriesKey("none")] = stamp({
        histogram: [],
        agg: null,
        total: primary.total,
        values: [{ v: "events", n: primary.total }],
      });
      continue;
    }
    if (widget.split === "level" && primarySplit === "level") {
      out[facetSeriesKey("level")] = stamp({
        histogram: [],
        agg: null,
        total: primary.total,
        values: levelFacetValuesFromHistogram(primary.histogram),
      });
    }
  }
  return out;
}
