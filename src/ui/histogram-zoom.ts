import {
  autoHistogramIntervalId,
  histogramBarCount,
  histogramIntervalIds,
  histogramIntervalMsById,
  isOneColumnInterval,
  nearestAllowedHistogramInterval,
  type HistogramChartKind,
  type HistogramIntervalId,
} from "../query/histogram";

/** Round windows the wheel and click-to-bar walk. Floor is one millisecond. */
export const histogramZoomSpansMs = [
  1, // 1ms
  10,
  100,
  1_000,
  5_000,
  15_000,
  30_000,
  60_000, // 1m
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  2 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  14 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
  90 * 24 * 60 * 60_000,
  180 * 24 * 60 * 60_000,
  365 * 24 * 60 * 60_000,
] as const;

export const minHistogramZoomMs = histogramZoomSpansMs[0];

export type HistogramWindow = { fromMs: number; toMs: number };

export function histogramIntervalMs(id: HistogramIntervalId): number {
  return histogramIntervalMsById[id];
}

export function snapHistogramSpanMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return minHistogramZoomMs;
  }
  for (const span of histogramZoomSpansMs) {
    if (span >= ms) {
      return span;
    }
  }
  return histogramZoomSpansMs[histogramZoomSpansMs.length - 1] ?? minHistogramZoomMs;
}

function nearestZoomIndex(spanMs: number): number {
  let best = 0;
  for (let i = 1; i < histogramZoomSpansMs.length; i++) {
    const cur = histogramZoomSpansMs[i];
    const prev = histogramZoomSpansMs[best];
    if (cur === undefined || prev === undefined) {
      continue;
    }
    if (Math.abs(cur - spanMs) < Math.abs(prev - spanMs)) {
      best = i;
    }
  }
  return best;
}

/** `dir` +1 widens (zoom out), −1 tightens. */
export function nextHistogramZoomMs(spanMs: number, dir: 1 | -1): number | null {
  const i = nearestZoomIndex(spanMs);
  const j = Math.max(0, Math.min(histogramZoomSpansMs.length - 1, i + dir));
  if (j === i) {
    return null;
  }
  return histogramZoomSpansMs[j] ?? null;
}

export function zoomHistogramAbout(
  spanMs: number,
  centerMs: number,
  dir: 1 | -1,
): HistogramWindow | null {
  const next = nextHistogramZoomMs(spanMs, dir);
  if (next === null || !Number.isFinite(centerMs)) {
    return null;
  }
  return { fromMs: Math.round(centerMs - next / 2), toMs: Math.round(centerMs + next / 2) };
}

/** Smallest ladder span that still draws, centred on the bar. Null when already that tight. */
export function clickHistogramWindow(
  bucketFromMs: number,
  bucketToMs: number,
  spanMs: number,
): HistogramWindow | null {
  const bucketMs = Math.max(0, bucketToMs - bucketFromMs);
  const drillMs = snapHistogramSpanMs(Math.max(bucketMs, 1));
  if (!Number.isFinite(spanMs) || drillMs >= spanMs) {
    return null;
  }
  const mid = (bucketFromMs + bucketToMs) / 2;
  return { fromMs: mid - drillMs / 2, toMs: mid + drillMs / 2 };
}

export const histogramRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Slide a window by `deltaMs` (positive looks later). Span unchanged. Null when clamped in place. */
export function panHistogramWindow(
  fromMs: number,
  toMs: number,
  deltaMs: number,
  nowMs: number,
  retentionMs = histogramRetentionMs,
): HistogramWindow | null {
  const span = toMs - fromMs;
  if (!(span > 0) || !Number.isFinite(span) || !Number.isFinite(deltaMs)) {
    return null;
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs <= 0) {
    return null;
  }
  const maxTo = nowMs;
  const minTo = nowMs - retentionMs + span;
  const lo = Math.min(minTo, maxTo);
  const hi = Math.max(minTo, maxTo);
  const nextTo = Math.max(lo, Math.min(hi, toMs + deltaMs));
  if (nextTo === toMs) {
    return null;
  }
  return { fromMs: nextTo - span, toMs: nextTo };
}

export function histogramHoverHint(opts: {
  shiftHeld: boolean;
  headArmed: boolean;
  canDrill: boolean;
  drillLabel: string;
}): string {
  if (opts.headArmed && opts.canDrill) {
    return `click → ${opts.drillLabel} · drag the head to sweep a span`;
  }
  if (opts.shiftHeld) {
    return "release to pin this span";
  }
  return "drag to pan · ⇧drag to select";
}

/** Drag keeps the drawn span, floored at 1ms. */
export function dragHistogramWindow(fromMs: number, toMs: number): HistogramWindow {
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const span = Math.max(minHistogramZoomMs, hi - lo);
  const mid = (lo + hi) / 2;
  return { fromMs: mid - span / 2, toMs: mid + span / 2 };
}

export function histogramExploreResetLabel(range: string): string {
  if (range === "custom") {
    return "the previous window";
  }
  return `Last ${range}`;
}

function chipBarBand(chart: HistogramChartKind): { min: number; max: number } {
  return chart === "grouped" ? { min: 4, max: 40 } : { min: 4, max: 240 };
}

export function histogramChipDrawable(
  spanMs: number,
  id: HistogramIntervalId,
  chart: HistogramChartKind,
): boolean {
  const n = histogramBarCount(spanMs, histogramIntervalMsById[id]);
  if (id === "1ms" && n >= 1 && n <= 3) {
    return true;
  }
  if (isOneColumnInterval(spanMs, id)) {
    return true;
  }
  const { min, max } = chipBarBand(chart);
  return n >= min && n <= max;
}

export function autoChipInterval(
  spanMs: number,
  chart: HistogramChartKind,
): HistogramIntervalId {
  if (chart !== "grouped") {
    return autoHistogramIntervalId(spanMs);
  }
  const target = 16;
  const prefer = histogramIntervalIds.filter((id) =>
    histogramChipDrawable(spanMs, id, chart),
  );
  if (prefer.length === 0) {
    return autoHistogramIntervalId(spanMs);
  }
  return [...prefer].sort((a, b) => {
    const da = Math.abs(
      histogramBarCount(spanMs, histogramIntervalMsById[a]) - target,
    );
    const db = Math.abs(
      histogramBarCount(spanMs, histogramIntervalMsById[b]) - target,
    );
    return da - db;
  })[0] ?? autoHistogramIntervalId(spanMs);
}

export function standingChipInterval(
  spanMs: number,
  wanted: HistogramIntervalId,
  chart: HistogramChartKind,
): HistogramIntervalId {
  if (histogramChipDrawable(spanMs, wanted, chart)) {
    return wanted;
  }
  const draw = histogramIntervalIds.filter((id) =>
    histogramChipDrawable(spanMs, id, chart),
  );
  if (draw.length === 0) {
    return nearestAllowedHistogramInterval(spanMs, wanted);
  }
  const wantedMs = histogramIntervalMs(wanted);
  return [...draw].sort((a, b) => {
    const da = Math.abs(Math.log(histogramIntervalMs(a) / wantedMs));
    const db = Math.abs(Math.log(histogramIntervalMs(b) / wantedMs));
    return da - db;
  })[0] ?? nearestAllowedHistogramInterval(spanMs, wanted);
}

export function histogramChipIds(
  spanMs: number,
  chart: HistogramChartKind,
): HistogramIntervalId[] {
  return histogramIntervalIds.filter((id) => histogramChipDrawable(spanMs, id, chart));
}

export function displayedHistogramInterval(
  spanMs: number,
  wanted: HistogramIntervalId | null,
  chart: HistogramChartKind,
): HistogramIntervalId {
  return wanted
    ? standingChipInterval(spanMs, wanted, chart)
    : autoChipInterval(spanMs, chart);
}

/** Step sent to `/api/search`. Null means omit `step=` (server auto). */
export function resolveQueryHistogramStep(
  spanMs: number,
  wanted: HistogramIntervalId | null,
  chart: HistogramChartKind,
): HistogramIntervalId | null {
  if (wanted) {
    return standingChipInterval(spanMs, wanted, chart);
  }
  if (chart === "grouped") {
    const grouped = autoChipInterval(spanMs, "grouped");
    if (grouped !== autoHistogramIntervalId(spanMs)) {
      return grouped;
    }
  }
  return null;
}

/** Grouped Auto is coarser; line/area/stacked share buckets and must not refetch. */
export function histogramChartNeedsRefetch(
  spanMs: number,
  wanted: HistogramIntervalId | null,
  prev: HistogramChartKind,
  next: HistogramChartKind,
): boolean {
  if (prev === next) {
    return false;
  }
  return (
    resolveQueryHistogramStep(spanMs, wanted, prev) !==
    resolveQueryHistogramStep(spanMs, wanted, next)
  );
}
