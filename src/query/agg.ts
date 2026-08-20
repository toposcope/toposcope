import { isAttrIdent } from "../shared/attrs";
import { type CompiledQuery } from "./compile";
import { rollupSource } from "./histogram";

export const numericAggOps = ["avg", "min", "max", "sum", "p99"] as const;
export type NumericAggOp = (typeof numericAggOps)[number];

export type SearchAgg =
  | { op: "rate" }
  | { op: NumericAggOp; key: string };

export type AggBucket = { t: string; v: number };

export type SearchAggResult = {
  expr: string;
  source: "numeric" | "rate" | "refused" | "metric";
  reason?: string;
  buckets: AggBucket[];
  stat: number | null;
};

export class InvalidAggError extends Error {
  constructor(raw: string) {
    super(`Invalid agg "${raw}"`);
    this.name = "InvalidAggError";
  }
}

const numericOp = new Set<string>(numericAggOps);

export function parseSearchAgg(raw: string | undefined): SearchAgg | null {
  if (raw === undefined) {
    return null;
  }
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.toLowerCase() === "rate") {
    return { op: "rate" };
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    throw new InvalidAggError(raw);
  }
  const op = value.slice(0, colon).toLowerCase();
  const key = value.slice(colon + 1).trim().toLowerCase();
  if (!numericOp.has(op) || !isAttrIdent(key)) {
    throw new InvalidAggError(raw);
  }
  return { op: op as NumericAggOp, key };
}

export function formatSearchAgg(agg: SearchAgg): string {
  if (agg.op === "rate") {
    return "rate";
  }
  return `${agg.op}:${agg.key}`;
}

export function aggLabel(agg: SearchAgg): string {
  if (agg.op === "rate") {
    return "rate";
  }
  return `${agg.op}(${agg.key})`;
}

/** Count when `agg` is off; otherwise `rate` or `p99(duration_ms)`. */
export function seriesLabel(expr: string | null | undefined): string {
  if (!expr) {
    return "Count";
  }
  try {
    const parsed = parseSearchAgg(expr);
    return parsed ? aggLabel(parsed) : expr;
  } catch {
    return expr;
  }
}

export const numericFieldRefuseReason = "p99/avg need a numeric field";
export const numericBudgetRefuseReason =
  "p99/avg over this query exceeds the scan budget";
export const logsScanBudgetRefuseReason =
  "this query exceeds the scan budget";

export class LogsScanBudgetError extends Error {
  constructor(message = logsScanBudgetRefuseReason) {
    super(message);
    this.name = "LogsScanBudgetError";
  }
}

/** Soak (100m/7d local): 24h `timeout` p99 ≈ 3.2M rows / 50MB / 0.1s; 7d ≈ 92M / 1.4GB / 1–7s. */
export const numericScanMaxRows = 20_000_000;
export const numericScanMaxBytes = 256 * 1024 * 1024;
export const numericScanMaxSeconds = 8;

export const numericScanSettings =
  `SETTINGS max_rows_to_read = ${numericScanMaxRows}, max_bytes_to_read = ${numericScanMaxBytes}, max_execution_time = ${numericScanMaxSeconds}, read_overflow_mode = 'throw'`;

const numericScanValue = "toFloat64OrNull(attr_map[{agg_key:String}])";

/** Numeric overlay uses the minute-shaped numeric MV. Rate uses the volume histogram. */
export function canUseNumericAgg(compiled: CompiledQuery): boolean {
  return rollupSource(compiled) === "minute";
}

export function numericKeyRefuseReason(
  key: string,
  skipKeys: Iterable<string> = [],
): string | null {
  if (!isAttrIdent(key)) {
    return numericFieldRefuseReason;
  }
  const skip = skipKeys instanceof Set ? skipKeys : new Set(skipKeys);
  if (skip.has(key)) {
    return numericFieldRefuseReason;
  }
  return null;
}

export function isNumericAggBudgetError(err: unknown): boolean {
  if (isAbortError(err)) {
    return true;
  }
  const text = err instanceof Error ? err.message : String(err);
  return /TIMEOUT_EXCEEDED|TOO_MANY_ROWS|TOO_MANY_BYTES|TOO_MANY_ROWS_OR_BYTES|max_rows_to_read|max_bytes_to_read|max_execution_time|Limit for rows \(controlled by 'max_rows_to_read'|Limit for rows \(or bytes\) to read exceeded|Code: 158\b|Code: 159\b|Code: 307\b|Code: 308\b/i.test(
    text,
  );
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  if (!("name" in err) || err.name !== "AbortError") {
    return false;
  }
  return true;
}

export function numericMergeSql(op: NumericAggOp): string {
  switch (op) {
    case "avg":
      return "sumMerge(v_sum) / nullIf(countMerge(n), 0)";
    case "min":
      return "minMerge(v_min)";
    case "max":
      return "maxMerge(v_max)";
    case "sum":
      return "sumMerge(v_sum)";
    case "p99":
      return "quantileTDigestMerge(0.99)(v_p99)";
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

export function numericScanSql(op: NumericAggOp): string {
  switch (op) {
    case "avg":
      return `avg(${numericScanValue})`;
    case "min":
      return `min(${numericScanValue})`;
    case "max":
      return `max(${numericScanValue})`;
    case "sum":
      return `sum(${numericScanValue})`;
    case "p99":
      return `quantileTDigest(0.99)(${numericScanValue})`;
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

export function numericScanFiniteSql(): string {
  return `isFinite(${numericScanValue})`;
}

export function windowSeconds(
  fromIso?: string | null,
  toIso?: string | null,
): number {
  if (!fromIso || !toIso) {
    return 0;
  }
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

export function rateFromHistogram(
  histogram: ReadonlyArray<{ t: string; n: number }>,
  intervalSec: number,
  spanSec: number,
): SearchAggResult {
  const buckets = histogram.map((bucket) => ({
    t: bucket.t,
    v: intervalSec > 0 ? bucket.n / intervalSec : 0,
  }));
  const total = histogram.reduce((sum, bucket) => sum + bucket.n, 0);
  return {
    expr: "rate",
    source: "rate",
    buckets,
    stat: spanSec > 0 ? total / spanSec : null,
  };
}

export function refusedAgg(expr: string, reason: string): SearchAggResult {
  return {
    expr,
    source: "refused",
    reason,
    buckets: [],
    stat: null,
  };
}

export function mergeAggBuckets(
  prev: AggBucket[],
  incoming: AggBucket[],
): AggBucket[] {
  if (incoming.length === 0) {
    return prev;
  }
  const byT = new Map(prev.map((bucket) => [bucket.t, bucket]));
  for (const bucket of incoming) {
    byT.set(bucket.t, bucket);
  }
  return [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
}

export function alignAggBuckets(
  times: readonly string[],
  points: readonly AggBucket[],
): Array<number | null> {
  const byT = new Map(points.map((point) => [point.t, point.v]));
  return times.map((t) => {
    const v = byT.get(t);
    return v === undefined ? null : v;
  });
}

export function finiteAggPeak(values: ReadonlyArray<number | null>): number {
  let peak = 1e-9;
  for (const v of values) {
    if (v !== null && Number.isFinite(v) && v > peak) {
      peak = v;
    }
  }
  return peak;
}
