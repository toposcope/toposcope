import { parseAttrFacets, parsePromotedCols, formatPromotedCols } from "../shared/attrs";
import { isBoardFieldKey } from "../shared/boards";
import { isRelativeRange } from "../query/relative";
import {
  formatSearchAgg,
  parseSearchAgg,
} from "../query/agg";
import {
  parseHistogramChart,
  parseHistogramInterval,
  parseHistogramSplit,
  type HistogramChartKind,
  type HistogramIntervalId,
  type HistogramSplit,
} from "../query/histogram";
import {
  defaultLayout,
  formatWidgetsParam,
  isSingleHistogram,
  parseWidgetsParam,
  primaryTimeseries,
  type WidgetDef,
} from "../shared/widgets";
import {
  formatMetricLabels,
  parseMetricLabels,
  parseMetricName,
} from "../shared/metric";

export type RangeMode = "custom" | string;

export type OperatorView = "search" | "alerts" | "fields";

export type SearchUrlState = {
  q: string;
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  saved: string | null;
  view: OperatorView;
  split: HistogramSplit;
  chart: HistogramChartKind;
  logScale: boolean;
  step: HistogramIntervalId | null;
  attrFacets: string[];
  cols: string[];
  agg: string | null;
  replaceY: boolean;
  logs: boolean;
  widgets: WidgetDef[];
  bind: Record<string, string>;
  boardKeys: string[] | null;
};

export function toLocalInput(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function isoFromLocal(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

export function localFromIso(iso: string | null | undefined, fallback: string): string {
  if (!iso) {
    return fallback;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return fallback;
  }
  return toLocalInput(new Date(ms));
}

function parseRangeMode(value: string): RangeMode {
  if (value === "custom" || isRelativeRange(value)) {
    return value;
  }
  return "1h";
}

export function defaultSearchUrlState(): SearchUrlState {
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 60 * 1000);
  return {
    q: "",
    range: "1h",
    from: toLocalInput(from),
    to: toLocalInput(to),
    live: false,
    saved: null,
    view: "search",
    split: "level",
    chart: "stacked",
    logScale: false,
    step: null,
    attrFacets: [],
    cols: [],
    agg: null,
    replaceY: false,
    logs: true,
    widgets: defaultLayout().widgets,
    bind: {},
    boardKeys: null,
  };
}

export function parseSearchUrl(search: string): SearchUrlState {
  const defaults = defaultSearchUrlState();
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const rangeRaw = params.get("range") ?? "";
  const range = parseRangeMode(rangeRaw);
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const split = parseHistogramSplit(params.get("split") ?? undefined);
  const chart = parseHistogramChart(params.get("chart") ?? undefined);
  const logScale = params.get("scale") === "log";
  const agg = parseAggParam(params.get("agg"));
  const replaceY = params.get("y") === "agg";
  const logs = params.get("logs") !== "0";
  const metric = parseMetricName(params.get("metric"));
  const metricLabels = metric ? parseMetricLabels(params.get("ml")) : {};
  const widgets = parseWidgetsParam(params.get("w"), {
    split,
    chart,
    agg,
    replaceY,
    logScale,
    metric,
    metricLabels,
  });
  const primary = primaryTimeseries(widgets);
  return {
    q: params.get("q") ?? "",
    range,
    from: localFromIso(fromParam, defaults.from),
    to: localFromIso(toParam, defaults.to),
    live: params.get("live") === "1",
    saved: params.get("saved"),
    view: parseOperatorView(params.get("view")),
    split: primary?.split ?? split,
    chart: primary?.chart ?? chart,
    logScale: primary?.logScale ?? logScale,
    step: parseHistogramInterval(params.get("step") ?? undefined) ?? null,
    attrFacets: parseAttrFacets(params.get("af")),
    cols: parsePromotedCols(params.get("cols")),
    agg: primary?.metric ? null : (primary?.agg ?? agg),
    replaceY: primary?.replaceY ?? replaceY,
    logs,
    widgets,
    bind: parseBindCandidates(params),
    boardKeys: null,
  };
}

const reservedSearchParams = new Set([
  "q",
  "range",
  "from",
  "to",
  "live",
  "saved",
  "view",
  "split",
  "chart",
  "scale",
  "step",
  "af",
  "cols",
  "agg",
  "y",
  "logs",
  "w",
  "metric",
  "ml",
]);

function parseBindCandidates(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of params.entries()) {
    const key = rawKey.toLowerCase();
    if (reservedSearchParams.has(key) || !isBoardFieldKey(key)) {
      continue;
    }
    if (value.trim().length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function parseOperatorView(raw: string | null): OperatorView {
  if (raw === "alerts" || raw === "fields") {
    return raw;
  }
  return "search";
}

function parseAggParam(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = parseSearchAgg(raw);
    return parsed ? formatSearchAgg(parsed) : null;
  } catch {
    return null;
  }
}

export function serializeSearchUrl(state: SearchUrlState): string {
  const params = new URLSearchParams();
  const q = state.q.trim();
  const boardKeys = state.boardKeys ?? [];
  if (boardKeys.length > 0 && state.saved) {
    params.set("saved", state.saved);
    for (const key of boardKeys) {
      const value = (state.bind ?? {})[key];
      if (value && value.trim().length > 0) {
        params.set(key, value);
      }
    }
  } else if (q) {
    params.set("q", q);
  }
  params.set("range", state.range);
  if (state.range === "custom") {
    const fromIso = isoFromLocal(state.from);
    const toIso = isoFromLocal(state.to);
    if (fromIso) {
      params.set("from", fromIso);
    }
    if (toIso) {
      params.set("to", toIso);
    }
  }
  if (state.live) {
    params.set("live", "1");
  }
  if (state.saved) {
    params.set("saved", state.saved);
  }
  if (state.view === "alerts" || state.view === "fields") {
    params.set("view", state.view);
  }
  if (state.split !== "level") {
    params.set("split", state.split);
  }
  if (state.chart !== "stacked") {
    params.set("chart", state.chart);
  }
  if (state.logScale) {
    params.set("scale", "log");
  }
  if (state.step) {
    params.set("step", state.step);
  }
  if (state.attrFacets.length > 0) {
    params.set("af", parseAttrFacets(state.attrFacets.join(",")).join(","));
  }
  const cols = formatPromotedCols(state.cols ?? []);
  if (cols) {
    params.set("cols", cols);
  }
  const widgets = state.widgets ?? defaultLayout().widgets;
  const primary = primaryTimeseries(widgets);
  if (primary?.metric) {
    params.set("metric", primary.metric);
    const ml = formatMetricLabels(primary.metricLabels);
    if (ml) {
      params.set("ml", ml);
    }
    if (state.replaceY || primary.replaceY) {
      params.set("y", "agg");
    }
  } else if (state.agg) {
    params.set("agg", state.agg);
    if (state.replaceY) {
      params.set("y", "agg");
    }
  }
  if (!state.logs) {
    params.set("logs", "0");
  }
  if (!isSingleHistogram(widgets)) {
    params.set("w", formatWidgetsParam(widgets));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}
