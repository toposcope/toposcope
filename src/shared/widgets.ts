import {
  formatSearchAgg,
  parseSearchAgg,
  seriesLabel,
} from "../query/agg";
import {
  histogramCharts,
  histogramSplits,
  parseHistogramChart,
  parseHistogramSplit,
  type HistogramChartKind,
  type HistogramSplit,
} from "../query/histogram";
import { isAttrIdent, maxAttrFacets } from "./attrs";
import {
  formatMetricLabels,
  parseMetricLabels,
  parseMetricName,
} from "./metric";

export const maxWidgets = 6;
export const defaultHbarN = 10;
export const minHbarN = 1;
export const maxHbarN = 50;
export const hbarNPresets = [5, 10, 20] as const;
export const widgetGridCols = 12;
export const widgetRowPx = 64;
export const widgetGapPx = 8;
export const defaultWidgetH = 4;
export const minTimeseriesH = 3;
export const minStatH = 2;
export const minHbarH = 2;
export const maxWidgetH = 8;
export const minWidgetW = 3;
export const minTimeseriesW = 4;
export const minStatW = 1;
/**
 * Head width at/under which Duplicate / Copy / Export collapse behind ⋯.
 * The mock used `w <= 4` as a proxy for this on its canvas; a 4-col card on a
 * wide Search column has room for the icons.
 */
export const extraHeadCollapsePx = 288;

export function extraHeadCollapsed(widthPx: number): boolean {
  return widthPx <= extraHeadCollapsePx;
}

export type ExtraOverflowPage = "more" | "copy" | "export";

/** Copy… / Export… stay on the ⋯ menu (same popover, next page). Duplicate and a format close it. */
export function extraOverflowAfterPick(
  pick: "duplicate" | "copy" | "export" | "format",
): ExtraOverflowPage | null {
  switch (pick) {
    case "copy":
      return "copy";
    case "export":
      return "export";
    case "duplicate":
    case "format":
      return null;
    default: {
      const _exhaustive: never = pick;
      return _exhaustive;
    }
  }
}
export const pinnedHistogramId = "a";

export const widgetKinds = ["timeseries", "stat", "hbar"] as const;
export type WidgetKind = (typeof widgetKinds)[number];

export type WidgetDef = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  split: HistogramSplit;
  chart: HistogramChartKind;
  agg: string | null;
  replaceY: boolean;
  logScale: boolean;
  /** H-bar grouping by an attr key (`status`); null uses `split`. */
  attr: string | null;
  /** H-bar: show each row as a share of the widget total. */
  pct: boolean;
  /** H-bar: how many named values to show (default 10). */
  n: number;
  /** Ingested metric overlay (mutually exclusive with log `agg`). */
  metric: string | null;
  metricLabels: Record<string, string>;
};

export type WidgetLayout = {
  logs: boolean;
  widgets: WidgetDef[];
};

export type SeriesQuery = {
  split: HistogramSplit;
  agg: string | null;
  metric: string | null;
  metricLabels: Record<string, string>;
};

const idLetters = "abcdef";

export function defaultTimeseries(partial?: Partial<WidgetDef>): WidgetDef {
  return clampWidget({
    id: "a",
    x: 0,
    y: 0,
    w: widgetGridCols,
    h: defaultWidgetH,
    split: "level",
    chart: "stacked",
    agg: null,
    replaceY: false,
    logScale: false,
    attr: null,
    pct: false,
    n: defaultHbarN,
    metric: null,
    metricLabels: {},
    ...partial,
    kind: "timeseries",
  });
}

export function defaultLayout(partial?: {
  split?: HistogramSplit;
  chart?: HistogramChartKind;
  agg?: string | null;
  replaceY?: boolean;
  logScale?: boolean;
  metric?: string | null;
  metricLabels?: Record<string, string>;
}): WidgetLayout {
  return {
    logs: true,
    widgets: [
      defaultTimeseries({
        split: partial?.split,
        chart: partial?.chart,
        agg: partial?.agg ?? null,
        replaceY: partial?.replaceY,
        logScale: partial?.logScale,
        metric: partial?.metric ?? null,
        metricLabels: partial?.metricLabels ?? {},
      }),
    ],
  };
}

export function isDefaultLayout(layout: WidgetLayout): boolean {
  if (!layout.logs || layout.widgets.length !== 1) {
    return false;
  }
  const w = layout.widgets[0];
  if (!w || w.kind !== "timeseries") {
    return false;
  }
  return (
    w.id === "a" &&
    w.x === 0 &&
    w.y === 0 &&
    w.w === widgetGridCols &&
    w.h === defaultWidgetH &&
    w.split === "level" &&
    w.chart === "stacked" &&
    w.agg === null &&
    !w.replaceY &&
    !w.logScale &&
    w.metric === null &&
    Object.keys(w.metricLabels).length === 0
  );
}

/** True when URL `w=` can be omitted (one default-size pinned histogram). */
export function isSingleHistogram(widgets: WidgetDef[]): boolean {
  const w = widgets[0];
  return (
    widgets.length === 1 &&
    w !== undefined &&
    w.kind === "timeseries" &&
    w.id === "a" &&
    w.x === 0 &&
    w.y === 0 &&
    w.w === widgetGridCols &&
    w.h === defaultWidgetH
  );
}

export function primaryTimeseries(widgets: WidgetDef[]): WidgetDef | null {
  return (
    widgets.find((w) => isPinnedHistogram(w)) ??
    widgets.find((w) => w.kind === "timeseries") ??
    null
  );
}

function finiteInt(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function isPinnedHistogram(widget: WidgetDef): boolean {
  return widget.id === pinnedHistogramId && widget.kind === "timeseries";
}

export function clampWidget(widget: WidgetDef): WidgetDef {
  const minW =
    widget.kind === "stat"
      ? minStatW
      : widget.kind === "timeseries"
        ? minTimeseriesW
        : minWidgetW;
  const minH =
    widget.kind === "stat"
      ? minStatH
      : widget.kind === "hbar"
        ? minHbarH
        : minTimeseriesH;
  const w = Math.min(widgetGridCols, Math.max(minW, finiteInt(widget.w, minW)));
  const x = Math.min(widgetGridCols - w, Math.max(0, finiteInt(widget.x, 0)));
  const h = Math.min(maxWidgetH, Math.max(minH, finiteInt(widget.h, minH)));
  const y = Math.max(0, finiteInt(widget.y, 0));
  const split = parseHistogramSplit(widget.split);
  const chart = parseHistogramChart(widget.chart);
  const metric =
    widget.kind === "hbar" ? null : parseMetricName(widget.metric);
  const metricLabels = metric
    ? parseMetricLabels(formatMetricLabels(widget.metricLabels ?? {}))
    : {};
  const agg = metric ? null : normalizeWidgetAgg(widget.kind, widget.agg);
  return {
    ...widget,
    id: sanitizeId(widget.id),
    x,
    y,
    w,
    h,
    split,
    chart,
    agg,
    replaceY: Boolean(widget.replaceY) && widget.kind === "timeseries",
    logScale: Boolean(widget.logScale) && widget.kind === "timeseries",
    attr: widget.kind === "hbar" ? normalizeHbarAttr(widget.attr) : null,
    pct: Boolean(widget.pct) && widget.kind === "hbar",
    n: widget.kind === "hbar" ? clampHbarN(widget.n) : defaultHbarN,
    metric,
    metricLabels,
  };
}

export function clampHbarN(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return defaultHbarN;
  }
  return Math.min(maxHbarN, Math.max(minHbarN, Math.round(n)));
}

function normalizeHbarAttr(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const key = raw.trim().toLowerCase();
  return isAttrIdent(key) ? key : null;
}

/** Share of `n` in `total` for a Top-N row (`pct` on). */
export function formatSharePct(n: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  const p = (n / total) * 100;
  if (p >= 9.95) {
    return `${Math.round(p)}%`;
  }
  if (p >= 0.05) {
    return `${p.toFixed(1)}%`;
  }
  return "<0.1%";
}

function sanitizeId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (/^[a-z]$/.test(id)) {
    return id;
  }
  return "a";
}

export function normalizeWidgetAgg(
  kind: WidgetKind,
  raw: string | null | undefined,
): string | null {
  if (!raw || raw === "count") {
    return kind === "stat" ? "count" : null;
  }
  if (raw === "rate") {
    return "rate";
  }
  try {
    const parsed = parseSearchAgg(raw);
    if (!parsed || parsed.op === "rate") {
      return parsed ? "rate" : null;
    }
    if (!isAttrIdent(parsed.key)) {
      return null;
    }
    return formatSearchAgg(parsed);
  } catch {
    return kind === "stat" ? "count" : null;
  }
}

export function nextWidgetId(widgets: WidgetDef[]): string | null {
  const used = new Set(widgets.map((w) => w.id));
  for (const id of idLetters) {
    if (!used.has(id)) {
      return id;
    }
  }
  return null;
}

function overlaps(a: WidgetDef, b: WidgetDef): boolean {
  return (
    a.id !== b.id &&
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function hasOverlap(widget: WidgetDef, others: WidgetDef[]): boolean {
  return others.some((item) => overlaps(widget, item));
}

/** Drop `widget` to the first non-overlapping row (same x/w). */
export function nudgeClear(widget: WidgetDef, others: WidgetDef[]): WidgetDef {
  let next = widget;
  for (let i = 0; i < 48; i++) {
    if (!hasOverlap(next, others)) {
      return next;
    }
    next = { ...next, y: next.y + 1 };
  }
  return next;
}

function compactUp(widget: WidgetDef, others: WidgetDef[]): WidgetDef {
  let next = widget;
  while (next.y > 0) {
    const up = { ...next, y: next.y - 1 };
    if (hasOverlap(up, others)) {
      break;
    }
    next = up;
  }
  return next;
}

/** First cell that fits, scanning rows top-down. */
export function firstGap(widgets: WidgetDef[], draft: WidgetDef): WidgetDef {
  const w = clampWidget(draft);
  const bottom = widgets.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x <= widgetGridCols - w.w; x++) {
      const cand = clampWidget({ ...w, x, y });
      if (!hasOverlap(cand, widgets)) {
        return cand;
      }
    }
  }
  return clampWidget({ ...w, x: 0, y: bottom });
}

/** Winner keeps its cell; others cascade down then compact up. Pinned histogram never moves. */
export function settleWidgets(widgets: WidgetDef[], winnerId: string): WidgetDef[] {
  const moved = widgets.find((item) => item.id === winnerId);
  if (!moved) {
    return widgets;
  }
  const pinned = widgets.find((item) => isPinnedHistogram(item) && item.id !== winnerId);
  const placed: WidgetDef[] = [];
  if (pinned) {
    placed.push(pinned);
  }
  placed.push(moved);
  const rest = widgets
    .filter((item) => item.id !== winnerId && item.id !== pinned?.id)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const byId = new Map<string, WidgetDef>();
  for (const widget of rest) {
    const settled = compactUp(nudgeClear(widget, placed), placed);
    placed.push(settled);
    byId.set(widget.id, settled);
  }
  return widgets.map((item) => {
    if (item.id === winnerId) {
      return moved;
    }
    if (item.id === pinned?.id) {
      return pinned;
    }
    return byId.get(item.id) ?? item;
  });
}

export function widgetTitle(widget: WidgetDef): string {
  switch (widget.kind) {
    case "stat":
      if (widget.metric) {
        return widget.metric;
      }
      return seriesLabel(widget.agg === "count" ? null : widget.agg);
    case "hbar": {
      const group = widget.attr ?? widget.split;
      return `Top-N ${group}`;
    }
    case "timeseries": {
      const series = widget.metric
        ? widget.metric
        : seriesLabel(widget.agg);
      return widget.split === "level" ? series : `${series} · ${widget.split}`;
    }
    default: {
      const _exhaustive: never = widget.kind;
      return _exhaustive;
    }
  }
}

export function placeWidget(
  widgets: WidgetDef[],
  draft: Omit<WidgetDef, "id" | "x" | "y"> & { id?: string; x?: number; y?: number },
): WidgetDef[] {
  if (widgets.length >= maxWidgets) {
    return widgets;
  }
  const id = draft.id ?? nextWidgetId(widgets);
  if (!id) {
    return widgets;
  }
  const placed = firstGap(
    widgets,
    clampWidget({
      ...defaultTimeseries(),
      ...draft,
      id,
      x: draft.x ?? 0,
      y: draft.y ?? 0,
    }),
  );
  return [...widgets, placed];
}

export function addHistogram(widgets: WidgetDef[]): WidgetDef[] {
  return placeWidget(widgets, {
    kind: "timeseries",
    w: 6,
    h: defaultWidgetH,
    split: "level",
    chart: "stacked",
    agg: null,
    replaceY: false,
    logScale: false,
    attr: null,
    pct: false,
    n: defaultHbarN,
    metric: null,
    metricLabels: {},
  });
}

export function addStat(widgets: WidgetDef[]): WidgetDef[] {
  return placeWidget(widgets, {
    kind: "stat",
    w: 4,
    h: 2,
    split: "level",
    chart: "stacked",
    agg: "count",
    replaceY: false,
    logScale: false,
    attr: null,
    pct: false,
    n: defaultHbarN,
    metric: null,
    metricLabels: {},
  });
}

export function addHbar(widgets: WidgetDef[]): WidgetDef[] {
  return placeWidget(widgets, {
    kind: "hbar",
    w: 6,
    h: 3,
    split: "level",
    chart: "stacked",
    agg: null,
    replaceY: false,
    logScale: false,
    attr: null,
    pct: false,
    n: defaultHbarN,
    metric: null,
    metricLabels: {},
  });
}

export function patchWidget(
  widgets: WidgetDef[],
  id: string,
  patch: Partial<WidgetDef>,
): WidgetDef[] {
  return widgets.map((item) =>
    item.id === id ? clampWidget({ ...item, ...patch, id: item.id, kind: patch.kind ?? item.kind }) : item,
  );
}

export function moveWidget(
  widgets: WidgetDef[],
  id: string,
  x: number,
  y: number,
): WidgetDef[] {
  const current = widgets.find((item) => item.id === id);
  if (!current || isPinnedHistogram(current)) {
    return widgets;
  }
  const pinned = widgets.find((item) => isPinnedHistogram(item));
  const moved = nudgeClear(
    clampWidget({ ...current, x, y }),
    pinned ? [pinned] : [],
  );
  return settleWidgets(
    widgets.map((item) => (item.id === id ? moved : item)),
    id,
  );
}

export function resizeWidget(
  widgets: WidgetDef[],
  id: string,
  w: number,
  h: number,
): WidgetDef[] {
  const current = widgets.find((item) => item.id === id);
  if (!current) {
    return widgets;
  }
  if (isPinnedHistogram(current)) {
    const resized = clampWidget({ ...current, x: 0, y: 0, w, h });
    return settleWidgets(
      widgets.map((item) => (item.id === id ? resized : item)),
      id,
    );
  }
  const pinned = widgets.find((item) => isPinnedHistogram(item));
  const resized = nudgeClear(
    clampWidget({ ...current, w, h }),
    pinned ? [pinned] : [],
  );
  return settleWidgets(
    widgets.map((item) => (item.id === id ? resized : item)),
    id,
  );
}

export function removeWidget(widgets: WidgetDef[], id: string): WidgetDef[] {
  const current = widgets.find((item) => item.id === id);
  if (!current || isPinnedHistogram(current)) {
    return widgets;
  }
  return widgets.filter((item) => item.id !== id);
}

export function duplicateWidget(widgets: WidgetDef[], id: string): WidgetDef[] {
  if (widgets.length >= maxWidgets) {
    return widgets;
  }
  const src = widgets.find((item) => item.id === id);
  const nid = nextWidgetId(widgets);
  if (!src || !nid || isPinnedHistogram(src)) {
    return widgets;
  }
  const tryAt = (x: number, y: number): WidgetDef | null => {
    const cand = clampWidget({ ...src, id: nid, x, y });
    return hasOverlap(cand, widgets) ? null : cand;
  };
  const copy =
    tryAt(src.x + src.w, src.y) ??
    tryAt(src.x, src.y + src.h) ??
    firstGap(widgets, { ...src, id: nid });
  return [...widgets, copy];
}

export function gridRows(widgets: WidgetDef[]): number {
  return Math.max(1, ...widgets.map((w) => w.y + w.h), defaultWidgetH);
}

export function widgetSeriesQuery(widget: WidgetDef): SeriesQuery {
  switch (widget.kind) {
    case "timeseries":
      return {
        split: widget.split,
        agg: widget.agg,
        metric: widget.metric,
        metricLabels: widget.metricLabels,
      };
    case "stat":
      if (widget.metric) {
        return {
          split: "level",
          agg: null,
          metric: widget.metric,
          metricLabels: widget.metricLabels,
        };
      }
      if (widget.agg && widget.agg !== "count") {
        return {
          split: "level",
          agg: widget.agg,
          metric: null,
          metricLabels: {},
        };
      }
      return { split: "level", agg: null, metric: null, metricLabels: {} };
    case "hbar":
      return {
        split: widget.split,
        agg: null,
        metric: null,
        metricLabels: {},
      };
    default: {
      const _exhaustive: never = widget.kind;
      return _exhaustive;
    }
  }
}

export function widgetSeriesQueries(widgets: WidgetDef[]): SeriesQuery[] {
  const out: SeriesQuery[] = [];
  const seen = new Set<string>();
  const add = (query: SeriesQuery) => {
    const key = seriesQueryKey(query);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(query);
  };
  if (widgets.length === 0) {
    add({ split: "level", agg: null, metric: null, metricLabels: {} });
    return out;
  }
  for (const widget of widgets) {
    switch (widget.kind) {
      case "timeseries":
        add(widgetSeriesQuery(widget));
        break;
      case "stat":
        add(widgetSeriesQuery(widget));
        break;
      case "hbar":
        break;
      default: {
        const _exhaustive: never = widget.kind;
        return _exhaustive;
      }
    }
  }
  return out;
}

export function seriesQueryKey(query: SeriesQuery): string {
  const ml = formatMetricLabels(query.metricLabels ?? {});
  return `${query.split}|${query.agg ?? ""}|${query.metric ?? ""}|${ml}`;
}

export function applySeriesSearchParams(
  params: URLSearchParams,
  query: SeriesQuery,
): void {
  params.set("split", query.split);
  params.delete("agg");
  params.delete("metric");
  params.delete("ml");
  if (query.metric) {
    params.set("metric", query.metric);
    const ml = formatMetricLabels(query.metricLabels);
    if (ml) {
      params.set("ml", ml);
    }
    return;
  }
  if (query.agg) {
    params.set("agg", query.agg);
  }
}

export function attrSeriesKey(key: string): string {
  return `attr|${key}`;
}

export function facetSeriesKey(split: HistogramSplit): string {
  return `facet|${split}`;
}

export type HbarFetch = {
  attrKeys: string[];
  attrLimit: number;
  coreLimit: number | null;
  none: boolean;
};

/** What Top-N widgets need from facet endpoints (not histogram search). */
export function widgetHbarFetch(widgets: WidgetDef[]): HbarFetch {
  let attrLimit = 0;
  let coreLimit: number | null = null;
  let none = false;
  const attrKeys = widgetAttrKeys(widgets);
  for (const widget of widgets) {
    if (widget.kind !== "hbar") {
      continue;
    }
    if (widget.attr) {
      attrLimit = Math.max(attrLimit, widget.n);
      continue;
    }
    if (widget.split === "none") {
      none = true;
      continue;
    }
    coreLimit = Math.max(coreLimit ?? 0, widget.n);
  }
  return {
    attrKeys,
    attrLimit: attrKeys.length > 0 ? attrLimit || defaultHbarN : 0,
    coreLimit,
    none,
  };
}

/** True when Top-N needs a facet fetch (new field or a higher N). Not a full search. */
export function hbarFetchNeedsNetwork(prev: HbarFetch, next: HbarFetch): boolean {
  if (
    prev.attrKeys.length !== next.attrKeys.length ||
    prev.attrKeys.some((key, i) => key !== next.attrKeys[i])
  ) {
    return true;
  }
  if (next.attrLimit > prev.attrLimit) {
    return true;
  }
  if (next.coreLimit !== null && (prev.coreLimit === null || next.coreLimit > prev.coreLimit)) {
    return true;
  }
  return false;
}

/**
 * Named Top-N rows plus `other` when N actually cuts the list (or fills
 * the requested N, so more values may exist). A short list is complete —
 * events that never had this field paint as `-`, not `other`.
 */
export function hbarRows(
  values: Array<{ v: string; n: number }>,
  n: number,
  total: number,
): Array<{ key: string; n: number }> {
  const cap = clampHbarN(n);
  const top = values.slice(0, cap);
  const named = top.reduce((sum, row) => sum + row.n, 0);
  const rows = top.map((row) => ({ key: row.v, n: row.n }));
  const rest = Math.max(0, total - named);
  if (rest <= 0) {
    return rows;
  }
  if (values.length < cap) {
    rows.push({ key: "-", n: rest });
    return rows;
  }
  rows.push({ key: "other", n: rest });
  return rows;
}

/** Filter / Exclude only apply to a real field value — not `other`, `-`, or `events`. */
export function hbarRowIsValue(key: string): boolean {
  return key !== "other" && key !== "-" && key !== "events";
}

/** Attr keys used by Top-N widgets (values rollup / attr-facets). */
export function widgetAttrKeys(widgets: WidgetDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const widget of widgets) {
    if (widget.kind !== "hbar" || !widget.attr || seen.has(widget.attr)) {
      continue;
    }
    seen.add(widget.attr);
    out.push(widget.attr);
    if (out.length >= maxAttrFacets) {
      break;
    }
  }
  return out;
}

const pinnedHbarAttrs = ["status", "path", "user_id"] as const;

/** Status/path/user_id first; keep the URL key even when the window has not seen it. */
export function pickerAttrKeys(
  keys: string[],
  current: string | null,
  skip: Iterable<string> = [],
): string[] {
  const seen = new Set<string>();
  const skipSet = new Set(
    [...skip].map((key) => key.trim().toLowerCase()).filter(Boolean),
  );
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    if (!raw) {
      return;
    }
    const key = raw.trim().toLowerCase();
    if (!isAttrIdent(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(key);
  };
  add(current);
  for (const key of pinnedHbarAttrs) {
    if (!skipSet.has(key)) {
      add(key);
    }
  }
  for (const key of keys) {
    if (!skipSet.has(key)) {
      add(key);
    }
  }
  return out;
}

/** `a` is the volume plot. Extra-only `w=` / saved JSON still get it at 0,0. */
function withPinnedHistogram(
  widgets: WidgetDef[],
  fallback?: Partial<WidgetDef>,
): WidgetDef[] {
  const existing = widgets.find((item) => isPinnedHistogram(item));
  const pinned = clampWidget({
    ...(existing ?? defaultTimeseries(fallback)),
    id: pinnedHistogramId,
    kind: "timeseries",
    x: 0,
    y: 0,
  });
  const extras = widgets.filter((item) => item.id !== pinnedHistogramId);
  const next = [pinned, ...extras].slice(0, maxWidgets);
  if (next.some((item) => item.id !== pinned.id && overlaps(item, pinned))) {
    return settleWidgets(next, pinned.id);
  }
  return next;
}

export function parseWidgetsParam(
  raw: string | null | undefined,
  fallback?: Partial<WidgetDef>,
): WidgetDef[] {
  if (!raw || raw.trim().length === 0) {
    return [defaultTimeseries(fallback)];
  }
  const widgets: WidgetDef[] = [];
  for (const part of raw.split("~")) {
    if (widgets.length >= maxWidgets) {
      break;
    }
    const parsed = parseWidgetToken(part);
    if (!parsed) {
      continue;
    }
    if (widgets.some((item) => item.id === parsed.id)) {
      continue;
    }
    widgets.push(parsed);
  }
  return withPinnedHistogram(widgets, fallback);
}

function parseWidgetToken(raw: string): WidgetDef | null {
  const parts = raw.trim().split(".");
  if (parts.length < 6) {
    return null;
  }
  const id = parts[0];
  const kindRaw = parts[1];
  const x = Number(parts[2]);
  const y = Number(parts[3]);
  const w = Number(parts[4]);
  const h = Number(parts[5]);
  if (!id || !kindRaw || [x, y, w, h].some((n) => !Number.isFinite(n))) {
    return null;
  }
  const kind: WidgetKind | null =
    kindRaw === "t"
      ? "timeseries"
      : kindRaw === "s"
        ? "stat"
        : kindRaw === "h"
          ? "hbar"
          : null;
  if (!kind) {
    return null;
  }
  let split: HistogramSplit = "level";
  let chart: HistogramChartKind = "stacked";
  let agg: string | null = kind === "stat" ? "count" : null;
  let replaceY = false;
  let logScale = false;
  let attr: string | null = null;
  let pct = false;
  let n = defaultHbarN;
  let metric: string | null = null;
  let metricLabels: Record<string, string> = {};
  const rest = parts.slice(6);
  if (kind === "timeseries") {
    if (rest[0] && (histogramSplits as readonly string[]).includes(rest[0])) {
      split = rest[0] as HistogramSplit;
      rest.shift();
    }
    if (rest[0] && (histogramCharts as readonly string[]).includes(rest[0])) {
      chart = rest[0] as HistogramChartKind;
      rest.shift();
    }
    const source = consumeMetricSource(rest);
    metric = source.metric;
    metricLabels = source.metricLabels;
    if (!metric && rest[0] && !isFlagToken(rest[0])) {
      agg = normalizeWidgetAgg("timeseries", rest[0] ?? null);
      rest.shift();
    }
    const flags = rest[0] ?? "";
    replaceY = flags.includes("y");
    logScale = flags.includes("z");
  } else if (kind === "stat") {
    const source = consumeMetricSource(rest);
    metric = source.metric;
    metricLabels = source.metricLabels;
    if (!metric && rest[0]) {
      agg = normalizeWidgetAgg("stat", rest[0]);
    }
  } else if (kind === "hbar") {
    if (rest[rest.length - 1] === "pct") {
      pct = true;
      rest.pop();
    }
    const nPart = rest[rest.length - 1];
    if (nPart && /^n\d+$/.test(nPart)) {
      n = clampHbarN(Number(nPart.slice(1)));
      rest.pop();
    }
    const group = rest.join(".");
    if (group && (histogramSplits as readonly string[]).includes(group)) {
      split = group as HistogramSplit;
    } else if (group) {
      attr = group;
    }
  }
  return clampWidget({
    id,
    kind,
    x,
    y,
    w,
    h,
    split,
    chart,
    agg,
    replaceY,
    logScale,
    attr,
    pct,
    n,
    metric,
    metricLabels,
  });
}

function isFlagToken(part: string | undefined): boolean {
  return part === "y" || part === "z" || part === "yz";
}

function consumeMetricSource(rest: string[]): {
  metric: string | null;
  metricLabels: Record<string, string>;
} {
  if (!rest[0]?.startsWith("m:")) {
    return { metric: null, metricLabels: {} };
  }
  const chunks = [rest.shift()!.slice(2)];
  while (rest[0] && !rest[0].startsWith("l:") && !isFlagToken(rest[0])) {
    chunks.push(rest.shift()!);
  }
  const metric = parseMetricName(chunks.join("."));
  let metricLabels: Record<string, string> = {};
  if (rest[0]?.startsWith("l:")) {
    const raw = rest.shift()!.slice(2);
    metricLabels = metric ? parseMetricLabels(raw) : {};
  }
  return { metric, metricLabels };
}

export function formatWidgetsParam(widgets: WidgetDef[]): string {
  return widgets
    .slice(0, maxWidgets)
    .map((widget) => formatWidgetToken(clampWidget(widget)))
    .join("~");
}

function formatWidgetToken(widget: WidgetDef): string {
  const geo = `${widget.id}.${kindToken(widget.kind)}.${widget.x}.${widget.y}.${widget.w}.${widget.h}`;
  switch (widget.kind) {
    case "timeseries": {
      const flags = `${widget.replaceY ? "y" : ""}${widget.logScale ? "z" : ""}`;
      const parts = [geo, widget.split, widget.chart];
      if (widget.metric) {
        parts.push(`m:${widget.metric}`);
        const ml = formatMetricLabels(widget.metricLabels);
        if (ml) {
          parts.push(`l:${ml}`);
        }
      } else if (widget.agg) {
        parts.push(widget.agg);
      }
      if (flags.length > 0) {
        parts.push(flags);
      }
      return parts.join(".");
    }
    case "stat":
      if (widget.metric) {
        const parts = [geo, `m:${widget.metric}`];
        const ml = formatMetricLabels(widget.metricLabels);
        if (ml) {
          parts.push(`l:${ml}`);
        }
        return parts.join(".");
      }
      return widget.agg && widget.agg !== "count"
        ? `${geo}.${widget.agg}`
        : geo;
    case "hbar": {
      const group = widget.attr ?? (widget.split !== "level" ? widget.split : "");
      const parts = [geo];
      if (group) {
        parts.push(group);
      }
      if (widget.n !== defaultHbarN) {
        parts.push(`n${widget.n}`);
      }
      if (widget.pct) {
        parts.push("pct");
      }
      return parts.join(".");
    }
    default: {
      const _exhaustive: never = widget.kind;
      return _exhaustive;
    }
  }
}

function kindToken(kind: WidgetKind): string {
  switch (kind) {
    case "timeseries":
      return "t";
    case "stat":
      return "s";
    case "hbar":
      return "h";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function parseSavedLayout(raw: unknown): WidgetLayout | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return null;
    }
    try {
      return parseSavedLayout(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") {
    return null;
  }
  const rec = raw as { logs?: unknown; widgets?: unknown };
  const logs = rec.logs === false ? false : true;
  if (!Array.isArray(rec.widgets)) {
    return { logs, widgets: defaultLayout().widgets };
  }
  const widgets: WidgetDef[] = [];
  for (const item of rec.widgets) {
    if (widgets.length >= maxWidgets) {
      break;
    }
    const parsed = parseSavedWidget(item);
    if (!parsed || widgets.some((w) => w.id === parsed.id)) {
      continue;
    }
    widgets.push(parsed);
  }
  return {
    logs,
    widgets: withPinnedHistogram(widgets, defaultLayout().widgets[0]),
  };
}

function parseSavedWidget(raw: unknown): WidgetDef | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== "timeseries" && kind !== "stat" && kind !== "hbar") {
    return null;
  }
  if (typeof rec.id !== "string") {
    return null;
  }
  return clampWidget({
    id: rec.id,
    kind,
    x: Number(rec.x),
    y: Number(rec.y),
    w: Number(rec.w),
    h: Number(rec.h),
    split: parseHistogramSplit(typeof rec.split === "string" ? rec.split : undefined),
    chart: parseHistogramChart(typeof rec.chart === "string" ? rec.chart : undefined),
    agg: typeof rec.agg === "string" || rec.agg === null ? rec.agg : null,
    replaceY: rec.replaceY === true,
    logScale: rec.logScale === true,
    attr: typeof rec.attr === "string" || rec.attr === null ? rec.attr : null,
    pct: rec.pct === true,
    n: typeof rec.n === "number" ? rec.n : defaultHbarN,
    metric: typeof rec.metric === "string" || rec.metric === null ? rec.metric : null,
    metricLabels: savedMetricLabels(rec.metricLabels),
  });
}

function savedMetricLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const tmp: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      tmp[key] = value;
    }
  }
  return parseMetricLabels(formatMetricLabels(tmp));
}

export function formatSavedLayout(layout: WidgetLayout): string | null {
  if (isDefaultLayout(layout)) {
    return null;
  }
  return JSON.stringify({
    logs: layout.logs,
    widgets: layout.widgets.slice(0, maxWidgets).map((w) => clampWidget(w)),
  });
}
