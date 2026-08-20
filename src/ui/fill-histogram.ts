import { histogramIntervalMs } from "../query/histogram";
import type { HistogramBucket } from "./types";

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

function bucketKey(iso: string, stepMs: number): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return 0;
  }
  return Math.floor(ms / stepMs) * stepMs;
}

export function fillHistogram(
  fromIso: string,
  toIso: string,
  buckets: HistogramBucket[],
  intervalMs?: number,
): HistogramBucket[] {
  const stepMs = intervalMs ?? histogramIntervalMs(fromIso, toIso);
  const start = bucketKey(fromIso, stepMs);
  const end = bucketKey(toIso, stepMs);
  if (!start || !end || end < start) {
    return buckets;
  }
  const byStep = new Map<number, HistogramBucket>();
  for (const bucket of buckets) {
    byStep.set(bucketKey(bucket.t, stepMs), bucket);
  }
  const filled: HistogramBucket[] = [];
  for (let t = start; t <= end; t += stepMs) {
    const bucket = byStep.get(t);
    filled.push({
      t: new Date(t).toISOString(),
      n: bucket?.n ?? 0,
      series: bucket?.series ?? {},
      by_level: bucket?.by_level ?? {},
    });
  }
  return filled;
}

/** Gap between painted bars, or the displayed grain when there is only one column. */
export function resolveHistogramStepMs(
  buckets: HistogramBucket[],
  fallbackMs: number,
): number {
  const first = buckets[0];
  const second = buckets[1];
  if (first && second) {
    const delta = Date.parse(second.t) - Date.parse(first.t);
    if (delta > 0) {
      return delta;
    }
  }
  return fallbackMs > 0 ? fallbackMs : 1;
}

export type HistogramClockPrecision = "ms" | "s" | "hm";

/** Clock grain follows the bar when it is finer than the window. */
export function histogramClockPrecision(
  spanMs: number,
  intervalMs?: number,
): HistogramClockPrecision {
  if (
    (Number.isFinite(spanMs) && spanMs <= SECOND_MS) ||
    (intervalMs !== undefined && intervalMs < SECOND_MS)
  ) {
    return "ms";
  }
  if (
    (Number.isFinite(spanMs) && spanMs <= 15 * MINUTE_MS) ||
    (intervalMs !== undefined && intervalMs < MINUTE_MS)
  ) {
    return "s";
  }
  return "hm";
}

export function abbrevCount(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const abs = Math.abs(Math.round(n));
  if (abs >= 1_000_000) {
    const v = abs / 1_000_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (abs >= 1000) {
    const v = abs / 1000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(abs);
}

/** Legend totals: exact under 10k, abbreviated after — same as the v2 mock. */
export function formatSeriesTotal(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const abs = Math.abs(Math.round(n));
  if (abs >= 10_000) {
    return abbrevCount(abs);
  }
  return abs.toLocaleString("en-US");
}

export function formatAggStat(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return "—";
  }
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return abbrevCount(n);
  }
  if (Number.isInteger(n) || abs >= 100) {
    return String(Math.round(n));
  }
  if (abs >= 10) {
    return n.toFixed(1).replace(/\.0$/, "");
  }
  if (abs >= 1) {
    return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  return n.toPrecision(2);
}

export function histogramYTicks(peak: number, logScale: boolean): number[] {
  if (peak <= 0) {
    return [0, 0, 0, 0];
  }
  if (!logScale) {
    return [peak, Math.round(peak * 0.66), Math.round(peak * 0.33), 0];
  }
  const logp = Math.log10(peak);
  return [
    peak,
    Math.round(10 ** (logp * 0.66)),
    Math.round(10 ** (logp * 0.33)),
    0,
  ];
}

export function scaleCount(value: number, peak: number, logScale: boolean): number {
  if (value <= 0 || peak <= 0) {
    return 0;
  }
  if (!logScale) {
    return value / peak;
  }
  return Math.log10(value + 1) / Math.log10(peak + 1);
}

/** Fraction of plot height for one stacked slice: scale the bucket total, then share. Never a sum of logs. */
export function stackedSegmentPlotFrac(
  n: number,
  bucketTotal: number,
  peak: number,
  logScale: boolean,
): number {
  if (n <= 0 || bucketTotal <= 0) {
    return 0;
  }
  return scaleCount(bucketTotal, peak, logScale) * (n / bucketTotal);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Date on the axis when the window is ≥1d, crosses midnight, or is not today. */
export function histogramWindowNeedsDate(
  fromMs: number,
  spanMs: number,
  nowMs: number,
): boolean {
  if (!(spanMs > 0) || !Number.isFinite(fromMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  if (spanMs >= DAY_MS) {
    return true;
  }
  const toMs = fromMs + spanMs;
  const today = utcDayKey(nowMs);
  return utcDayKey(fromMs) !== utcDayKey(toMs) || utcDayKey(fromMs) !== today;
}

/** Seconds under 15m (or when the bar is <1m); milliseconds when the bar or window is ≤1s. */
export function histogramAxisTick(
  ms: number,
  spanMs: number,
  opts?: { withDate?: boolean; intervalMs?: number },
): string {
  const d = new Date(ms);
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const mmm = pad3(d.getUTCMilliseconds());
  const md = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (spanMs > 365 * DAY_MS) {
    return `${String(d.getUTCFullYear()).slice(2)}-${pad2(d.getUTCMonth() + 1)}`;
  }
  if (spanMs > 7 * DAY_MS) {
    return md;
  }
  const dated = opts?.withDate ?? spanMs >= DAY_MS;
  const precision = histogramClockPrecision(spanMs, opts?.intervalMs);
  const clock =
    precision === "ms"
      ? `${hh}:${mm}:${ss}.${mmm}`
      : precision === "s"
        ? `${hh}:${mm}:${ss}`
        : `${hh}:${mm}`;
  if (dated || spanMs >= DAY_MS) {
    return `${md} ${clock}`;
  }
  return clock;
}

/** Evenly spaced ticks under the histogram. Last tick is "now" in Live. */
export function histogramAxisLabels(
  fromMs: number,
  spanMs: number,
  live: boolean,
  nowMs = Date.now(),
  ticks = 5,
  intervalMs?: number,
): string[] {
  if (!(spanMs > 0) || !Number.isFinite(fromMs) || ticks < 1) {
    return [];
  }
  if (ticks === 1) {
    return [live ? "now" : histogramAxisTick(fromMs, spanMs, { intervalMs })];
  }
  const last = ticks - 1;
  const needsDate = histogramWindowNeedsDate(fromMs, spanMs, nowMs);
  let prevDay: string | null = null;
  return Array.from({ length: ticks }, (_, i) => {
    if (i === last && live) {
      return "now";
    }
    const ms = fromMs + (spanMs * i) / last;
    const day = utcDayKey(ms);
    const withDate =
      spanMs >= DAY_MS || (needsDate && (prevDay === null || day !== prevDay));
    prevDay = day;
    return histogramAxisTick(ms, spanMs, { withDate, intervalMs });
  });
}

/** Map a pointer offset inside the plot (padding excluded) to a bucket index. */
export function bucketIndexAt(
  offsetX: number,
  innerWidth: number,
  count: number,
): number {
  if (count <= 0 || innerWidth <= 0) {
    return 0;
  }
  const raw = Math.floor((offsetX / innerWidth) * count);
  return Math.min(count - 1, Math.max(0, raw));
}

export function rangeDurationMs(fromLocal: string, toLocal: string): number {
  const start = Date.parse(fromLocal);
  const end = Date.parse(toLocal);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return 60 * MINUTE_MS;
  }
  return end - start;
}
