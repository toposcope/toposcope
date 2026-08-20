import { isIdShapedValue } from "../shared/ids";
import { analyzeQuery, forEachAttrKv, type CompiledQuery } from "./compile";

export const histogramSplits = ["level", "service", "host", "none"] as const;
export type HistogramSplit = (typeof histogramSplits)[number];

export const histogramCharts = ["stacked", "grouped", "line", "area"] as const;
export type HistogramChartKind = (typeof histogramCharts)[number];

export function parseHistogramSplit(value: string | undefined): HistogramSplit {
  if (value && (histogramSplits as readonly string[]).includes(value)) {
    return value as HistogramSplit;
  }
  return "level";
}

export function parseHistogramChart(
  value: string | undefined,
): HistogramChartKind {
  if (value && (histogramCharts as readonly string[]).includes(value)) {
    return value as HistogramChartKind;
  }
  return "stacked";
}

export type RollupSource = "minute" | "attr" | "logs";

function attrEqualityNeedsLogs(
  compiled: CompiledQuery,
  skipKeys: Iterable<string>,
): boolean {
  const skip = skipKeys instanceof Set ? skipKeys : new Set(skipKeys);
  let needs = false;
  forEachAttrKv(compiled, (node) => {
    if (skip.has(node.key) || (!node.glob && isIdShapedValue(node.value))) {
      needs = true;
    }
  });
  return needs;
}

/** Minute MV (optional host); one attr-value MV; else scan `logs`. */
export function rollupSource(
  compiled: CompiledQuery,
  skipKeys: Iterable<string> = [],
): RollupSource {
  const shape = analyzeQuery(compiled);
  if (shape.hasMessage || shape.hasAttrNot || shape.attrOrWithOther || shape.hasAttrCmp) {
    return "logs";
  }
  if (shape.attrKeys.length >= 2) {
    return "logs";
  }
  if (shape.attrKeys.length === 1) {
    if (attrEqualityNeedsLogs(compiled, skipKeys)) {
      return "logs";
    }
    return "attr";
  }
  return "minute";
}

export function canUseHistogramMv(
  compiled: CompiledQuery,
  skipKeys: Iterable<string> = [],
): boolean {
  return rollupSource(compiled, skipKeys) === "minute";
}

export function canUseAttrValuesMv(
  compiled: CompiledQuery,
  skipKeys: Iterable<string> = [],
): boolean {
  return rollupSource(compiled, skipKeys) === "attr";
}

export function singleAttrKey(compiled: CompiledQuery): string | undefined {
  const keys = analyzeQuery(compiled).attrKeys;
  return keys.length === 1 ? keys[0] : undefined;
}

export const histogramIntervalIds = [
  "1ms",
  "10ms",
  "100ms",
  "1s",
  "10s",
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "7d",
] as const;
export type HistogramIntervalId = (typeof histogramIntervalIds)[number];

export const histogramIntervalMsById = {
  "1ms": 1,
  "10ms": 10,
  "100ms": 100,
  "1s": 1000,
  "10s": 10_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "7d": 604_800_000,
} as const;

export type HistogramIntervalMs =
  (typeof histogramIntervalMsById)[HistogramIntervalId];

/** Minute rollups cannot draw a finer bar. */
export const minuteHistogramMs = 60_000;

export function histogramUsesMinuteRollup(intervalMs: number): boolean {
  return intervalMs >= minuteHistogramMs;
}

/** Finest interval whose bar count stays in this band. */
export const maxHistogramBarsAuto = 200;
/** Slider / `step=` must not request more bars than this. */
export const maxHistogramBarsOverride = 500;

export function parseHistogramInterval(
  value: string | undefined,
): HistogramIntervalId | undefined {
  if (value && (histogramIntervalIds as readonly string[]).includes(value)) {
    return value as HistogramIntervalId;
  }
  return undefined;
}

export function histogramBarCount(spanMs: number, intervalMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0 || intervalMs <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(spanMs / intervalMs));
}

/** One column of this grain: window fits, next-finer grain would split it. */
export function isOneColumnInterval(
  spanMs: number,
  id: HistogramIntervalId,
): boolean {
  const intervalMs = histogramIntervalMsById[id];
  if (histogramBarCount(spanMs, intervalMs) !== 1) {
    return false;
  }
  const i = histogramIntervalIds.indexOf(id);
  if (i <= 0) {
    return true;
  }
  const finer = histogramIntervalIds[i - 1];
  return (
    finer !== undefined &&
    histogramBarCount(spanMs, histogramIntervalMsById[finer]) > 1
  );
}

export function histogramIntervalAllowed(
  spanMs: number,
  id: HistogramIntervalId,
): boolean {
  const n = histogramBarCount(spanMs, histogramIntervalMsById[id]);
  if (n > maxHistogramBarsOverride || n < 1) {
    return false;
  }
  if (n >= 2) {
    return true;
  }
  return isOneColumnInterval(spanMs, id);
}

/** Finest tick that stays at or under `maxHistogramBarsAuto`. */
export function autoHistogramIntervalId(spanMs: number): HistogramIntervalId {
  if (!Number.isFinite(spanMs) || spanMs <= 0) {
    return "1ms";
  }
  for (const id of histogramIntervalIds) {
    if (histogramBarCount(spanMs, histogramIntervalMsById[id]) <= maxHistogramBarsAuto) {
      return id;
    }
  }
  return histogramIntervalIds[histogramIntervalIds.length - 1] ?? "7d";
}

export function clampHistogramInterval(
  spanMs: number,
  override: HistogramIntervalId | null | undefined,
): HistogramIntervalId | null {
  if (!override || !histogramIntervalAllowed(spanMs, override)) {
    return null;
  }
  return override;
}

export function nearestAllowedHistogramInterval(
  spanMs: number,
  id: HistogramIntervalId,
): HistogramIntervalId {
  if (histogramIntervalAllowed(spanMs, id)) {
    return id;
  }
  const i = histogramIntervalIds.indexOf(id);
  for (let d = 1; d < histogramIntervalIds.length; d++) {
    const lo = i >= d ? histogramIntervalIds[i - d] : undefined;
    if (lo && histogramIntervalAllowed(spanMs, lo)) {
      return lo;
    }
    const hi = histogramIntervalIds[i + d];
    if (hi && histogramIntervalAllowed(spanMs, hi)) {
      return hi;
    }
  }
  return autoHistogramIntervalId(spanMs);
}

function spanMsFromIso(fromIso?: string, toIso?: string): number | undefined {
  if (!fromIso || !toIso) {
    return undefined;
  }
  const span = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(span) ? span : undefined;
}

export function resolveHistogramIntervalId(
  fromIso?: string,
  toIso?: string,
  override?: string,
): HistogramIntervalId {
  const span = spanMsFromIso(fromIso, toIso);
  if (span === undefined) {
    return "1m";
  }
  const parsed = parseHistogramInterval(override);
  if (parsed && histogramIntervalAllowed(span, parsed)) {
    return parsed;
  }
  return autoHistogramIntervalId(span);
}

/** Auto interval from the window, or a clamped `step=` override. */
export function histogramIntervalMs(
  fromIso?: string,
  toIso?: string,
  override?: string,
): HistogramIntervalMs {
  return histogramIntervalMsById[resolveHistogramIntervalId(fromIso, toIso, override)];
}

/** Bucket width in seconds (rate = count / this). */
export function histogramIntervalSeconds(
  fromIso?: string,
  toIso?: string,
  override?: string,
): number {
  return histogramIntervalMs(fromIso, toIso, override) / 1000;
}

/** Floor `since` to the bucket start so live polls refresh the in-progress bar. */
export function tightenHistogramFrom(
  fromIso: string | undefined,
  sinceIso: string | undefined,
  intervalMs: number,
): string | undefined {
  if (!sinceIso) {
    return fromIso;
  }
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs) || !(intervalMs > 0)) {
    return fromIso;
  }
  const start = Math.floor(sinceMs / intervalMs) * intervalMs;
  if (!fromIso) {
    return new Date(start).toISOString();
  }
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) {
    return new Date(start).toISOString();
  }
  return new Date(Math.max(fromMs, start)).toISOString();
}

export function histogramIntervalSql(intervalMs: HistogramIntervalMs): string {
  switch (intervalMs) {
    case 1:
      return "INTERVAL 1 MILLISECOND";
    case 10:
      return "INTERVAL 10 MILLISECOND";
    case 100:
      return "INTERVAL 100 MILLISECOND";
    case 1000:
      return "INTERVAL 1 SECOND";
    case 10_000:
      return "INTERVAL 10 SECOND";
    case 60_000:
      return "INTERVAL 1 minute";
    case 300_000:
      return "INTERVAL 5 minute";
    case 900_000:
      return "INTERVAL 15 minute";
    case 3_600_000:
      return "INTERVAL 1 hour";
    case 14_400_000:
      return "INTERVAL 4 hour";
    case 86_400_000:
      return "INTERVAL 1 day";
    case 604_800_000:
      return "INTERVAL 7 day";
    default: {
      const _exhaustive: never = intervalMs;
      return _exhaustive;
    }
  }
}
