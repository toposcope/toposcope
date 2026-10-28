import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { bucketQuantile, bucketSums } from "../shared/histogram-quantile";
import {
  defaultHistogramReading,
  metricExpr,
  parseMetricRef,
  readingQuantile,
  type HistogramReading,
} from "../shared/metric";
import { metricKind, type MetricKind } from "../shared/metric-kinds";
import { metricDescription } from "../shared/metric-descriptions";
import { metricUnit } from "../shared/metric-units";
import { maxAttrKeys } from "../shared/attrs";
import {
  histogramIntervalSql,
  histogramUsesMinuteRollup,
  tightenHistogramFrom,
  type HistogramIntervalMs,
} from "./histogram";
import { type SearchAggResult } from "./agg";

type WhereClause = {
  sql: string;
  params: Record<string, string>;
};

function finiteNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function metricTimeWhere(
  column: "ts" | "minute",
  filters: { from?: string; to?: string; since?: string; exact?: boolean },
): WhereClause {
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  const parse =
    column === "minute"
      ? (p: string) => `toStartOfMinute(parseDateTime64BestEffort({${p}:String}))`
      : (p: string) => `parseDateTime64BestEffort({${p}:String})`;
  if (filters.from) {
    where.push(`${column} >= ${parse("from")}`);
    params.from = filters.from;
  }
  if (filters.to) {
    where.push(`${column} ${filters.exact ? "<" : "<="} ${parse("to")}`);
    params.to = filters.to;
  }
  return { sql: where.join(" AND "), params };
}

/**
 * A label's value on a point, by the name of its parameter. `toposcope`, the instance a point
 * entered at (#331), is a column of its own, not a label, and is read as one.
 */
function labelRef(param: string, key: string): string {
  return key === "toposcope" ? "toposcope" : `labels[{${param}:String}]`;
}

function pushLabels(
  where: string[],
  params: Record<string, string>,
  labels: Record<string, string>,
): void {
  let i = 0;
  for (const [key, value] of Object.entries(labels)) {
    params[`mlk${i}`] = key;
    params[`mlv${i}`] = value;
    where.push(`${labelRef(`mlk${i}`, key)} = {mlv${i}:String}`);
    i++;
  }
}

/** A histogram and how it is read: the name itself, or the `.count` / `.sum` an older link carries. */
type HistogramRead = { base: string; reading: HistogramReading };

/**
 * Which histogram a name means, if any. A name sent with buckets is one, read
 * as asked or as its p99. `<name>.count` and `<name>.sum` of one are that
 * histogram's count and sum: links made before buckets were kept carry them.
 */
async function asHistogram(name: string, reading: HistogramReading | null): Promise<HistogramRead | null> {
  if ((await metricKind(name)) === "histogram") {
    return { base: name, reading: reading ?? defaultHistogramReading };
  }
  for (const part of ["count", "sum"] as const) {
    const base = name.endsWith(`.${part}`) ? name.slice(0, -part.length - 1) : "";
    if (base.length > 0 && (await metricKind(base)) === "histogram") {
      return { base, reading: part };
    }
  }
  return null;
}

type SeriesOpts = {
  from?: string;
  to?: string;
  since?: string;
  intervalMs: HistogramIntervalMs;
  labels: Record<string, string>;
  exact?: boolean;
  exclude?: { key: string; values: readonly string[] };
  /** One line per value of this label (#104): the 8 with the most points, and `other`. */
  split?: string;
};

/** Lines a split panel draws, before the rest are `other`. */
export const metricSplitCap = 8;
export const metricSplitOther = "other";

/**
 * The bars asked for and the whole window, for its one number. Unlabeled bars
 * of a minute or more read the minute rollup; label matchers and finer bars
 * scan the stored points.
 */
function seriesWindows(
  opts: SeriesOpts,
  scan = false,
): { rolled: boolean; overlay: WhereClause; stat: WhereClause } {
  const overlay = {
    from: tightenHistogramFrom(opts.from, opts.since, opts.intervalMs),
    to: opts.to,
    exact: opts.exact,
  };
  // The minute rollup has no labels: a matcher or a split reads the stored points.
  const labeled = Object.keys(opts.labels).length > 0 || Boolean(opts.split);
  if (!scan && !opts.exact && !opts.exclude && !labeled && histogramUsesMinuteRollup(opts.intervalMs)) {
    return {
      rolled: true,
      overlay: metricTimeWhere("minute", overlay),
      stat: metricTimeWhere("minute", { from: opts.from, to: opts.to }),
    };
  }
  const windows = {
    rolled: false,
    overlay: metricTimeWhere("ts", overlay),
    stat: metricTimeWhere("ts", { from: opts.from, to: opts.to, exact: opts.exact }),
  };
  for (const where of [windows.overlay, windows.stat]) {
    const parts = [where.sql];
    pushLabels(parts, where.params, opts.labels);
    if (opts.exclude) {
      where.params.exclude_key = opts.exclude.key;
      where.params.exclude_values = JSON.stringify(opts.exclude.values);
      parts.push(`${labelRef("exclude_key", opts.exclude.key)} NOT IN JSONExtract({exclude_values:String}, 'Array(String)')`);
    }
    where.sql = parts.join(" AND ");
  }
  return windows;
}

/** What a result says about itself, beside its bars. */
type Told = Pick<SearchAggResult, "expr" | "kind" | "reading" | "metric" | "unit" | "description">;

/**
 * The unit a reading is in. A histogram's values and sum carry its unit; its
 * count is a number of observations and has none. An older histogram may have
 * its unit only on `<name>.sum`.
 */
async function readingUnit(name: string, reading: HistogramReading | null): Promise<string | null> {
  if (reading === null) {
    return metricUnit(name);
  }
  if (reading === "count") {
    return null;
  }
  return (await metricUnit(name)) ?? (await metricUnit(`${name}.sum`));
}

/**
 * The unit a panel's metric reads in (#169), its histogram reading included:
 * what one axis must share when metrics are merged. Null when none was sent.
 */
export async function metricRefUnit(ref: string): Promise<string | null> {
  const parsed = parseMetricRef(ref);
  const name = parsed?.name ?? ref;
  const histogram = await asHistogram(name, parsed?.reading ?? null);
  return histogram ? readingUnit(histogram.base, histogram.reading) : metricUnit(name);
}

/** `{ unit }` when there is one, so a reply without a unit does not carry the key. */
const withUnit = (unit: string | null) => (unit ? { unit } : {});

/**
 * What a histogram's sender said it is (#167). It describes every reading,
 * its count included. An older histogram may have it only on `<name>.sum`.
 */
async function histogramDescription(base: string): Promise<string | null> {
  return (await metricDescription(base)) ?? (await metricDescription(`${base}.sum`));
}

/** `{ description }` when there is one, so a reply without one does not carry the key. */
const withDescription = (description: string | null) => (description ? { description } : {});

/**
 * Ingested samples, read by the kind the name came as: a counter is the sum of
 * what arrived in each bar, a gauge the average of its points, and a histogram
 * one reading of its distribution. Unlabeled uses the minute rollups. Label
 * matchers scan the stored points (not `logs`). Log `q` is never applied.
 */
export async function searchMetricSeries(
  opts: SeriesOpts & { name: string; reading?: HistogramReading | null },
): Promise<SearchAggResult> {
  const histogram = await asHistogram(opts.name, opts.reading ?? null);
  if (histogram) {
    const told: Told = {
      expr: metricExpr(histogram.base, opts.labels, histogram.reading),
      kind: "histogram",
      reading: histogram.reading,
      metric: histogram.base,
      ...withUnit(await readingUnit(histogram.base, histogram.reading)),
      ...withDescription(await histogramDescription(histogram.base)),
    };
    const q = readingQuantile(histogram.reading);
    if (histogram.reading === "heatmap" || q !== null) {
      // Buckets sent in two units are two histograms (#331): each read off its own sums, never one heatmap.
      const groups = await metaGroups("metric_buckets", opts, "name = {metric_name:String}", { metric_name: histogram.base }, "histogram");
      if (groups) {
        return metaQuantileSeries(opts, histogram.base, q ?? 0.99, told, groups);
      }
    }
    if (histogram.reading === "heatmap") {
      return heatmapSeries(opts, histogram.base, told);
    }
    if (q !== null) {
      return quantileSeries(opts, histogram.base, q, told);
    }
    const count = `${histogram.base}.count`;
    const sum = `${histogram.base}.sum`;
    // A count has no unit; its sum's says which unit the observations were in.
    const said = histogram.reading === "count" ? count : sum;
    const groups = await metaGroups("metrics", opts, "name = {said_name:String}", { said_name: said }, "counter");
    if (groups) {
      return metaValueSeries(opts, told, groups, histogram.reading === "avg" ? { avg: { sum, count } } : { amount: said }, "counter");
    }
    if (histogram.reading === "avg") {
      return valueSeries(opts, told, {
        names: "name IN ({sum_name:String}, {count_name:String})",
        params: { sum_name: sum, count_name: count },
        rolled:
          "sumMergeIf(v_sum, name = {sum_name:String}) / nullIf(sumMergeIf(v_sum, name = {count_name:String}), 0)",
        scanned:
          "sumIf(value, name = {sum_name:String}) / nullIf(sumIf(value, name = {count_name:String}), 0)",
      });
    }
    return valueSeries(opts, told, amountOf(histogram.reading === "sum" ? sum : count));
  }
  const counter = (await metricKind(opts.name)) === "counter";
  const told: Told = {
    expr: metricExpr(opts.name, opts.labels),
    kind: counter ? "counter" : "gauge",
    ...withUnit(await metricUnit(opts.name)),
    ...withDescription(await metricDescription(opts.name)),
  };
  const groups = await metaGroups("metrics", opts, "name = {metric_name:String}", { metric_name: opts.name }, told.kind!);
  if (groups) {
    return metaValueSeries(opts, told, groups, { level: opts.name }, told.kind!);
  }
  return valueSeries(
    opts,
    told,
    counter
      ? amountOf(opts.name)
      : {
          names: "name = {metric_name:String}",
          params: { metric_name: opts.name },
          rolled: "sumMerge(v_sum) / nullIf(countMerge(n), 0)",
          scanned: "avg(value)",
        },
  );
}

/** How one number per bar is worked out, from the rollup or from the points. */
type ValueRead = { names: string; params: Record<string, string>; rolled: string; scanned: string };

/** An amount: the sum of what arrived. */
function amountOf(name: string): ValueRead {
  return {
    names: "name = {metric_name:String}",
    params: { metric_name: name },
    rolled: "sumMerge(v_sum)",
    scanned: "sum(value)",
  };
}

/** The values of the split label with the most points in the window: 8 kept, and whether there are more. */
async function splitKeys(
  table: "metrics" | "metric_buckets",
  split: string,
  stat: WhereClause,
  names: string,
  params: Record<string, string>,
): Promise<{ keep: string[]; other: boolean }> {
  const rows = await clickhouseQuery<{ k: string }>(
    `
    SELECT ${labelRef("split_key", split)} AS k, count() AS n
    FROM ${table}
    WHERE ${stat.sql} AND ${names}
    GROUP BY k
    ORDER BY n DESC, k ASC
    LIMIT ${metricSplitCap + 1}
  `,
    { ...stat.params, ...params },
  );
  return {
    keep: rows.slice(0, metricSplitCap).map((row) => String(row.k)),
    other: rows.length > metricSplitCap,
  };
}

/** The split label's value, or `other` past the 8 kept. */
function splitKeySql(split: string): string {
  const value = labelRef("split_key", split);
  return `if(${value} IN JSONExtract({split_keep:String}, 'Array(String)'), ${value}, {split_other:String})`;
}

function splitResult(
  told: Told,
  split: string,
  keys: { keep: string[]; other: boolean },
  rows: Array<{ bucket: string; k: string; v: number | null }>,
  stats: Array<{ k: string; v: number | null }>,
): SearchAggResult {
  const order = keys.other ? [...keys.keep, metricSplitOther] : keys.keep;
  const splits = order.map((key) => ({
    key,
    buckets: rows
      .filter((row) => row.k === key && row.v !== null)
      .map((row) => ({ t: toIsoTimestamp(String(row.bucket)), v: row.v as number })),
    stat: stats.find((row) => row.k === key)?.v ?? null,
  }));
  return { ...told, source: "metric", buckets: [], stat: null, split, splits };
}

async function valueSeries(opts: SeriesOpts, told: Told, read: ValueRead): Promise<SearchAggResult> {
  if (opts.split) {
    return splitValueSeries(opts, opts.split, told, read);
  }
  const { rolled, overlay, stat } = seriesWindows(opts);
  const table = rolled ? "metrics_by_minute" : "metrics";
  const clock = rolled ? "minute" : "ts";
  const v = rolled ? read.rolled : read.scanned;
  const [rows, statRows] = await Promise.all([
    clickhouseQuery<{ bucket: string; v: string | number | null }>(
      `
      SELECT
        toStartOfInterval(${clock}, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
        ${v} AS v
      FROM ${table}
      WHERE ${overlay.sql} AND ${read.names}
      GROUP BY bucket
      ORDER BY bucket
    `,
      { ...overlay.params, ...read.params },
    ),
    clickhouseQuery<{ v: string | number | null }>(
      `
      SELECT ${v} AS v
      FROM ${table}
      WHERE ${stat.sql} AND ${read.names}
    `,
      { ...stat.params, ...read.params },
    ),
  ]);
  return metricResult(
    told,
    rows.map((row) => ({ bucket: row.bucket, v: finiteNum(row.v) })),
    finiteNum(statRows[0]?.v),
  );
}

async function splitValueSeries(
  opts: SeriesOpts,
  split: string,
  told: Told,
  read: ValueRead,
): Promise<SearchAggResult> {
  const { overlay, stat } = seriesWindows(opts);
  const keys = await splitKeys("metrics", split, stat, read.names, { ...read.params, split_key: split });
  const params = {
    ...read.params,
    split_key: split,
    split_keep: JSON.stringify(keys.keep),
    split_other: metricSplitOther,
  };
  const [rows, stats] = await Promise.all([
    clickhouseQuery<{ bucket: string; k: string; v: string | number | null }>(
      `
      SELECT
        toStartOfInterval(ts, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
        ${splitKeySql(split)} AS k,
        ${read.scanned} AS v
      FROM metrics
      WHERE ${overlay.sql} AND ${read.names}
      GROUP BY bucket, k
      ORDER BY bucket
    `,
      { ...overlay.params, ...params },
    ),
    clickhouseQuery<{ k: string; v: string | number | null }>(
      `
      SELECT ${splitKeySql(split)} AS k, ${read.scanned} AS v
      FROM metrics
      WHERE ${stat.sql} AND ${read.names}
      GROUP BY k
    `,
      { ...stat.params, ...params },
    ),
  ]);
  return splitResult(
    told,
    split,
    keys,
    rows.map((row) => ({ bucket: row.bucket, k: String(row.k), v: finiteNum(row.v) })),
    stats.map((row) => ({ k: String(row.k), v: finiteNum(row.v) })),
  );
}

/**
 * A percentile of a histogram: its bucket counts summed by bound, across every
 * series that matches and every point in the bar, and the percentile read off
 * the sum. Never a percentile of each series averaged afterwards.
 */
async function quantileSeries(
  opts: SeriesOpts,
  name: string,
  q: number,
  told: Told,
): Promise<SearchAggResult> {
  if (opts.split) {
    return splitQuantileSeries(opts, opts.split, name, q, told);
  }
  const { rolled, overlay, stat } = seriesWindows(opts);
  const clock = rolled ? "minute" : "ts";
  // One row for each bound: from the rollup as stored, from the points by unfolding their arrays.
  const source = rolled
    ? "metric_buckets_by_minute"
    : "metric_buckets ARRAY JOIN arrayPushBack(le, inf) AS bound, n AS observed";
  const bound = rolled ? "le" : "bound";
  const observed = rolled ? "sum(n)" : "sum(observed)";
  const [rows, statRows] = await Promise.all([
    clickhouseQuery<{ bucket: string; les: unknown; ns: unknown }>(
      `
      SELECT bucket, groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT
          toStartOfInterval(${clock}, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
          ${bound} AS upper,
          ${observed} AS c
        FROM ${source}
        WHERE ${overlay.sql} AND name = {metric_name:String}
        GROUP BY bucket, upper
      )
      GROUP BY bucket
      ORDER BY bucket
    `,
      { ...overlay.params, metric_name: name },
    ),
    clickhouseQuery<{ les: unknown; ns: unknown }>(
      `
      SELECT groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT ${bound} AS upper, ${observed} AS c
        FROM ${source}
        WHERE ${stat.sql} AND name = {metric_name:String}
        GROUP BY upper
      )
    `,
      { ...stat.params, metric_name: name },
    ),
  ]);
  return metricResult(
    told,
    rows.map((row) => ({ bucket: row.bucket, v: bucketQuantile(q, bucketSums(row.les, row.ns)) })),
    bucketQuantile(q, bucketSums(statRows[0]?.les, statRows[0]?.ns)),
  );
}

/**
 * A histogram as a heatmap (#238): per bar, its bucket counts summed by bound across every series
 * that matches, as the percentile reads them; the bounds are the union over the window. Its line is
 * the p99 of each bar, so the panel can draw it over the cells. A split is not offered.
 */
async function heatmapSeries(opts: SeriesOpts, name: string, told: Told): Promise<SearchAggResult> {
  const p99 = await quantileSeries({ ...opts, split: undefined }, name, 0.99, told);
  const { rolled, overlay } = seriesWindows(opts);
  const clock = rolled ? "minute" : "ts";
  const source = rolled
    ? "metric_buckets_by_minute"
    : "metric_buckets ARRAY JOIN arrayPushBack(le, inf) AS bound, n AS observed";
  const bound = rolled ? "le" : "bound";
  const observed = rolled ? "sum(n)" : "sum(observed)";
  const rows = await clickhouseQuery<{ bucket: string; les: unknown; ns: unknown }>(
    `
    SELECT bucket, groupArray(upper) AS les, groupArray(c) AS ns
    FROM (
      SELECT
        toStartOfInterval(${clock}, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
        ${bound} AS upper,
        ${observed} AS c
      FROM ${source}
      WHERE ${overlay.sql} AND name = {metric_name:String}
      GROUP BY bucket, upper
    )
    GROUP BY bucket
    ORDER BY bucket
  `,
    { ...overlay.params, metric_name: name },
  );
  return { ...p99, heat: heatCells(rows.map((row) => ({ t: toIsoTimestamp(String(row.bucket)), sums: bucketSums(row.les, row.ns) }))) };
}

/** One grid from bars whose bounds may differ: the union of bounds, each bar's counts placed on it. */
export function heatCells(bars: Array<{ t: string; sums: { le: number[]; n: number[] } }>): {
  le: number[];
  cells: Array<{ t: string; n: number[] }>;
} {
  const le = [...new Set(bars.flatMap((bar) => bar.sums.le))].sort((a, b) => a - b);
  const at = new Map(le.map((bound, i) => [bound, i]));
  return {
    le,
    cells: bars.map((bar) => {
      const n = new Array<number>(le.length).fill(0);
      bar.sums.le.forEach((bound, i) => {
        n[at.get(bound)!]! += bar.sums.n[i] ?? 0;
      });
      return { t: bar.t, n };
    }),
  };
}

/** A split percentile: each value's bucket counts summed by bound, the percentile read off each sum. */
async function splitQuantileSeries(
  opts: SeriesOpts,
  split: string,
  name: string,
  q: number,
  told: Told,
): Promise<SearchAggResult> {
  const { overlay, stat } = seriesWindows(opts);
  const keys = await splitKeys("metric_buckets", split, stat, "name = {metric_name:String}", {
    metric_name: name,
    split_key: split,
  });
  const params = {
    metric_name: name,
    split_key: split,
    split_keep: JSON.stringify(keys.keep),
    split_other: metricSplitOther,
  };
  const source = "metric_buckets ARRAY JOIN arrayPushBack(le, inf) AS bound, n AS observed";
  const [rows, stats] = await Promise.all([
    clickhouseQuery<{ bucket: string; k: string; les: unknown; ns: unknown }>(
      `
      SELECT bucket, k, groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT
          toStartOfInterval(ts, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
          ${splitKeySql(split)} AS k,
          bound AS upper,
          sum(observed) AS c
        FROM ${source}
        WHERE ${overlay.sql} AND name = {metric_name:String}
        GROUP BY bucket, k, upper
      )
      GROUP BY bucket, k
      ORDER BY bucket
    `,
      { ...overlay.params, ...params },
    ),
    clickhouseQuery<{ k: string; les: unknown; ns: unknown }>(
      `
      SELECT k, groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT ${splitKeySql(split)} AS k, bound AS upper, sum(observed) AS c
        FROM ${source}
        WHERE ${stat.sql} AND name = {metric_name:String}
        GROUP BY k, upper
      )
      GROUP BY k
    `,
      { ...stat.params, ...params },
    ),
  ]);
  return splitResult(
    told,
    split,
    keys,
    rows.map((row) => ({ bucket: row.bucket, k: String(row.k), v: bucketQuantile(q, bucketSums(row.les, row.ns)) })),
    stats.map((row) => ({ k: String(row.k), v: bucketQuantile(q, bucketSums(row.les, row.ns)) })),
  );
}

/**
 * A kind and unit a name's points came with in a window (#331), the instances they entered at,
 * and when the first and last of them were.
 */
type MetaGroup = NonNullable<SearchAggResult["units_differ"]>[number];

/**
 * The kinds and units the matching points of a name carry in the window, when they are more
 * than one (#331): a panel then splits by them rather than sum what disagrees. A point that
 * came without a kind reads as the name's own; one without a unit is apart only when two
 * others disagree, so points stored before units travelled with them never split a line.
 */
async function metaGroups(
  table: "metrics" | "metric_buckets",
  opts: SeriesOpts,
  names: string,
  params: Record<string, string>,
  ownKind: string,
): Promise<MetaGroup[] | null> {
  const { stat } = seriesWindows(opts, true);
  const rows = await clickhouseQuery<{ k: string; u: string; sources: unknown; first: string; last: string }>(
    `
    SELECT
      if(kind = '', {own_kind:String}, kind) AS k,
      unit AS u,
      arraySort(groupUniqArray(toposcope)) AS sources,
      min(ts) AS first,
      max(ts) AS last
    FROM ${table}
    WHERE ${stat.sql} AND ${names}
    GROUP BY k, u
    ORDER BY first, k, u
  `,
    { ...stat.params, ...params, own_kind: ownKind },
  );
  const units = new Set(rows.map((row) => String(row.u)).filter((u) => u.length > 0));
  const kinds = new Set(rows.map((row) => String(row.k)));
  if (units.size <= 1 && kinds.size <= 1) {
    return null;
  }
  return rows.map((row) => ({
    kind: String(row.k),
    unit: String(row.u),
    sources: Array.isArray(row.sources) ? row.sources.map(String) : [],
    first: toIsoTimestamp(String(row.first)),
    last: toIsoTimestamp(String(row.last)),
  }));
}

/** How a line split by kind and unit is named: by what differs, and by its label's value when the panel splits. */
function metaLineKey(group: MetaGroup, groups: readonly MetaGroup[], value: string | null): string {
  const kinds = new Set(groups.map((g) => g.kind)).size > 1;
  const units = new Set(groups.map((g) => g.unit)).size > 1;
  const unit = group.unit || "no unit";
  const said = kinds && units ? `${group.kind} · ${unit}` : kinds ? group.kind : unit;
  return value === null ? said : `${value} · ${said}`;
}

const metaKindSql = "if(kind = '', {own_kind:String}, kind)";

/** A series split by kind and unit, each line read the way its kind is: lines with no points are left out. */
function metaResult(
  told: Told,
  split: string | undefined,
  keys: { keep: string[]; other: boolean } | null,
  groups: readonly MetaGroup[],
  rows: Array<{ bucket: string; k: string; mk: string; mu: string; v: number | null }>,
  stats: Array<{ k: string; mk: string; mu: string; v: number | null }>,
): SearchAggResult {
  const values: Array<string | null> = keys ? (keys.other ? [...keys.keep, metricSplitOther] : keys.keep) : [null];
  const splits: NonNullable<SearchAggResult["splits"]> = [];
  for (const value of values) {
    for (const group of groups) {
      const mine = (row: { k: string; mk: string; mu: string }) =>
        (value === null || row.k === value) && row.mk === group.kind && row.mu === group.unit;
      const buckets = rows
        .filter((row) => mine(row) && row.v !== null)
        .map((row) => ({ t: toIsoTimestamp(String(row.bucket)), v: row.v as number }));
      const stat = stats.find(mine)?.v ?? null;
      if (buckets.length === 0 && stat === null) {
        continue;
      }
      splits.push({
        key: metaLineKey(group, groups, value),
        buckets,
        stat,
        kind: group.kind,
        ...(group.unit ? { unit: group.unit } : {}),
      });
    }
  }
  return {
    ...told,
    source: "metric",
    buckets: [],
    stat: null,
    ...(split ? { split } : {}),
    splits,
    units_differ: [...groups],
  };
}

/**
 * Points of one name in more than one kind or unit (#331), one line for each. A level averages,
 * an amount sums, and a histogram's average is its sum over its count, each paired with the
 * sum point sent beside it so the count takes the sum's unit.
 */
async function metaValueSeries(
  opts: SeriesOpts,
  told: Told,
  groups: readonly MetaGroup[],
  read: { level: string } | { amount: string } | { avg: { sum: string; count: string } },
  /** What a point sent without a kind reads as: what `metaGroups` was told. */
  ownKind: string,
): Promise<SearchAggResult> {
  const { overlay, stat } = seriesWindows(opts, true);
  const params: Record<string, string> = { own_kind: ownKind };
  let names: string;
  let value: string;
  if ("avg" in read) {
    names = "name IN ({sum_name:String}, {count_name:String})";
    params.sum_name = read.avg.sum;
    params.count_name = read.avg.count;
    value = "sum(s) / nullIf(sum(c), 0)";
  } else {
    names = "name = {metric_name:String}";
    params.metric_name = "level" in read ? read.level : read.amount;
    value = "level" in read ? "if(mk = 'counter', sum(value), avg(value))" : "sum(value)";
  }
  const keys = opts.split ? await splitKeys("metrics", opts.split, stat, names, { ...params, split_key: opts.split }) : null;
  if (opts.split && keys) {
    params.split_key = opts.split;
    params.split_keep = JSON.stringify(keys.keep);
    params.split_other = metricSplitOther;
  }
  const k = opts.split ? splitKeySql(opts.split) : "''";
  const from = (where: WhereClause) =>
    "avg" in read
      ? `(
        SELECT ts, ${k} AS k,
          anyIf(${metaKindSql}, name = {sum_name:String}) AS mk,
          anyIf(unit, name = {sum_name:String}) AS mu,
          sumIf(value, name = {sum_name:String}) AS s,
          sumIf(value, name = {count_name:String}) AS c
        FROM metrics
        WHERE ${where.sql} AND ${names}
        GROUP BY ts, toposcope, labels
      )`
      : `(
        SELECT ts, ${k} AS k, ${metaKindSql} AS mk, unit AS mu, value
        FROM metrics
        WHERE ${where.sql} AND ${names}
      )`;
  const [rows, stats] = await Promise.all([
    clickhouseQuery<{ bucket: string; k: string; mk: string; mu: string; v: string | number | null }>(
      `
      SELECT toStartOfInterval(ts, ${histogramIntervalSql(opts.intervalMs)}) AS bucket, k, mk, mu, ${value} AS v
      FROM ${from(overlay)}
      GROUP BY bucket, k, mk, mu
      ORDER BY bucket
    `,
      { ...overlay.params, ...params },
    ),
    clickhouseQuery<{ k: string; mk: string; mu: string; v: string | number | null }>(
      `
      SELECT k, mk, mu, ${value} AS v
      FROM ${from(stat)}
      GROUP BY k, mk, mu
    `,
      { ...stat.params, ...params },
    ),
  ]);
  const text = <T extends { k: string; mk: string; mu: string; v: string | number | null }>(row: T) => ({
    ...row,
    k: String(row.k),
    mk: String(row.mk),
    mu: String(row.mu),
    v: finiteNum(row.v),
  });
  return metaResult(told, opts.split, keys, groups, rows.map(text), stats.map(text));
}

/**
 * A percentile of a histogram sent in more than one unit (#331): within each unit its bucket
 * counts summed by bound across every matching series, and the percentile read off that sum.
 * Never across units. A heatmap of it is its p99 lines.
 */
async function metaQuantileSeries(
  opts: SeriesOpts,
  name: string,
  q: number,
  told: Told,
  groups: readonly MetaGroup[],
): Promise<SearchAggResult> {
  const { overlay, stat } = seriesWindows(opts, true);
  const params: Record<string, string> = { metric_name: name, own_kind: "histogram" };
  const names = "name = {metric_name:String}";
  const keys = opts.split ? await splitKeys("metric_buckets", opts.split, stat, names, { ...params, split_key: opts.split }) : null;
  if (opts.split && keys) {
    params.split_key = opts.split;
    params.split_keep = JSON.stringify(keys.keep);
    params.split_other = metricSplitOther;
  }
  const k = opts.split ? splitKeySql(opts.split) : "''";
  const source = "metric_buckets ARRAY JOIN arrayPushBack(le, inf) AS bound, n AS observed";
  const [rows, stats] = await Promise.all([
    clickhouseQuery<{ bucket: string; k: string; mk: string; mu: string; les: unknown; ns: unknown }>(
      `
      SELECT bucket, k, mk, mu, groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT
          toStartOfInterval(ts, ${histogramIntervalSql(opts.intervalMs)}) AS bucket,
          ${k} AS k,
          ${metaKindSql} AS mk,
          unit AS mu,
          bound AS upper,
          sum(observed) AS c
        FROM ${source}
        WHERE ${overlay.sql} AND ${names}
        GROUP BY bucket, k, mk, mu, upper
      )
      GROUP BY bucket, k, mk, mu
      ORDER BY bucket
    `,
      { ...overlay.params, ...params },
    ),
    clickhouseQuery<{ k: string; mk: string; mu: string; les: unknown; ns: unknown }>(
      `
      SELECT k, mk, mu, groupArray(upper) AS les, groupArray(c) AS ns
      FROM (
        SELECT ${k} AS k, ${metaKindSql} AS mk, unit AS mu, bound AS upper, sum(observed) AS c
        FROM ${source}
        WHERE ${stat.sql} AND ${names}
        GROUP BY k, mk, mu, upper
      )
      GROUP BY k, mk, mu
    `,
      { ...stat.params, ...params },
    ),
  ]);
  const read = <T extends { k: string; mk: string; mu: string; les: unknown; ns: unknown }>(row: T) => ({
    ...row,
    k: String(row.k),
    mk: String(row.mk),
    mu: String(row.mu),
    v: bucketQuantile(q, bucketSums(row.les, row.ns)),
  });
  return metaResult(told, opts.split, keys, groups, rows.map(read), stats.map(read));
}

/** The label keys a metric's points carry in the window, with how many values each: the split picker (13f). */
export async function metricLabelKeys(opts: {
  name: string;
  from?: string;
  to?: string;
}): Promise<Array<{ key: string; values: number }>> {
  const histogram = await asHistogram(opts.name, null);
  const names = histogram ? [`${histogram.base}.count`, `${histogram.base}.sum`] : [opts.name];
  const { sql, params } = metricTimeWhere("ts", { from: opts.from, to: opts.to });
  const rows = await clickhouseQuery<{ key: string; values: string | number }>(
    `
    SELECT key, uniqExact(value) AS values
    FROM (
      SELECT tupleElement(kv, 1) AS key, tupleElement(kv, 2) AS value
      FROM metrics
      ARRAY JOIN CAST(labels, 'Array(Tuple(String, String))') AS kv
      WHERE ${sql} AND name IN JSONExtract({names:String}, 'Array(String)')
    )
    GROUP BY key
    ORDER BY key
    LIMIT ${maxAttrKeys}
  `,
    { ...params, names: JSON.stringify(names) },
  );
  const keys = rows.map((row) => ({ key: String(row.key), values: Number(row.values) }));
  // The instance a point entered at (#331) is a column, not a label: offered once points came from more than one.
  const [sources] = await clickhouseQuery<{ values: string | number }>(
    `SELECT uniqExact(toposcope) AS values FROM metrics WHERE ${sql} AND name IN JSONExtract({names:String}, 'Array(String)')`,
    { ...params, names: JSON.stringify(names) },
  );
  const instances = Number(sources?.values ?? 0);
  if (instances > 1 && !keys.some((row) => row.key === "toposcope")) {
    keys.push({ key: "toposcope", values: instances });
    keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return keys;
}

function metricResult(
  told: Told,
  rows: Array<{ bucket: string; v: number | null }>,
  stat: number | null,
): SearchAggResult {
  const buckets: SearchAggResult["buckets"] = [];
  for (const row of rows) {
    if (row.v !== null) {
      buckets.push({ t: toIsoTimestamp(String(row.bucket)), v: row.v });
    }
  }
  return { ...told, source: "metric", buckets, stat };
}

export type MetricNameRow = {
  k: string;
  n: number;
  kind: MetricKind;
  /** For the `.count` or `.sum` of a histogram: the histogram it is a reading of. */
  of?: string;
  reading?: HistogramReading;
  /** The unit it was last sent with. A histogram's is the unit of its values. */
  unit?: string;
  /** The description it was last sent with (#167). */
  description?: string;
};

/** A name with no stored kind was posted as a plain point and reads as a gauge. */
async function withKinds(rows: Array<{ k: string; n: number }>): Promise<MetricNameRow[]> {
  const out: MetricNameRow[] = [];
  for (const row of rows) {
    const kind = (await metricKind(row.k)) ?? "gauge";
    const unit = await readingUnit(row.k, kind === "histogram" ? defaultHistogramReading : null);
    const description = kind === "histogram" ? await histogramDescription(row.k) : await metricDescription(row.k);
    out.push({ ...row, kind, ...withUnit(unit), ...withDescription(description) });
  }
  return out;
}

/** The names kept as histograms. */
const histogramNamesSql = `
  SELECT DISTINCT name FROM metric_buckets
  WHERE tenant_id = {tenant_id:String}
`;

/**
 * Stored names as the list shows them: a histogram's `<name>.count` and
 * `<name>.sum` are the one name `<name>`, counted by its count's points.
 */
function foldedNames(where: string): string {
  return `
    SELECT if(base IN hist, base, name) AS k, n
    FROM (
      SELECT
        name,
        multiIf(
          endsWith(name, '.count'), substring(name, 1, length(name) - 6),
          endsWith(name, '.sum'), substring(name, 1, length(name) - 4),
          ''
        ) AS base,
        n
      FROM metrics_by_minute
      WHERE ${where} AND name != ''
    )
    WHERE NOT (endsWith(name, '.sum') AND base IN hist)
  `;
}

/**
 * Names with points in the window, busiest first, each with its kind.
 * `find` keeps the names that contain it, anywhere, in any case. `total` counts
 * every name with points, found or not. `picked` answers for the names a card
 * already holds, points or no points: a saved search can carry one that went quiet.
 */
export async function metricNames(opts: {
  from?: string;
  to?: string;
  find?: string;
  picked?: readonly string[];
}): Promise<{ keys: MetricNameRow[]; total: number; picked: MetricNameRow[] }> {
  const { sql, params } = metricTimeWhere("minute", opts);
  const find = (opts.find ?? "").trim().toLowerCase();
  const picked = [...new Set(opts.picked ?? [])].slice(0, maxAttrKeys);
  const listParams: Record<string, string> = { ...params };
  let found = "";
  if (find.length > 0) {
    listParams.find = find;
    found = "HAVING positionCaseInsensitive(k, {find:String}) > 0";
  }
  // A picked histogram has points when its count has; an older link's `.count` is looked up as it is.
  const pickedAs = new Map<string, { stored: string; histogram: HistogramRead | null }>();
  for (const name of picked) {
    const histogram = await asHistogram(name, null);
    pickedAs.set(name, {
      stored: histogram && histogram.base === name ? `${name}.count` : name,
      histogram,
    });
  }
  const stored = [...pickedAs.values()].map((entry) => entry.stored);
  const pickedParams: Record<string, string> = { ...params, picked: JSON.stringify(stored) };
  const number = (value: string | number | undefined) =>
    typeof value === "number" ? value : Number(value ?? 0);
  const [rows, totals, pickedRows] = await Promise.all([
    clickhouseQuery<{ k: string; n: string | number }>(
      `
    WITH hist AS (${histogramNamesSql})
    SELECT k, countMerge(n) AS n
    FROM (${foldedNames(sql)})
    GROUP BY k
    ${found}
    ORDER BY n DESC, k ASC
    LIMIT ${maxAttrKeys}
  `,
      listParams,
    ),
    clickhouseQuery<{ total: string | number }>(
      `
    WITH hist AS (${histogramNamesSql})
    SELECT uniqExact(k) AS total FROM (${foldedNames(sql)})
  `,
      params,
    ),
    stored.length === 0
      ? Promise.resolve([])
      : clickhouseQuery<{ k: string; n: string | number }>(
          `
    SELECT name AS k, countMerge(n) AS n
    FROM metrics_by_minute
    WHERE ${sql} AND name IN JSONExtract({picked:String}, 'Array(String)')
    GROUP BY k
  `,
          pickedParams,
        ),
  ]);
  const withPoints = new Map(pickedRows.map((row) => [String(row.k), number(row.n)]));
  const pickedOut: MetricNameRow[] = [];
  for (const [name, { stored: storedName, histogram }] of pickedAs) {
    const n = withPoints.get(storedName) ?? 0;
    if (!histogram) {
      pickedOut.push({
        k: name,
        n,
        kind: (await metricKind(name)) ?? "gauge",
        ...withUnit(await metricUnit(name)),
        ...withDescription(await metricDescription(name)),
      });
    } else if (histogram.base === name) {
      pickedOut.push({
        k: name,
        n,
        kind: "histogram",
        ...withUnit(await readingUnit(name, defaultHistogramReading)),
        ...withDescription(await histogramDescription(name)),
      });
    } else {
      pickedOut.push({
        k: name,
        n,
        kind: "histogram",
        of: histogram.base,
        reading: histogram.reading,
        ...withUnit(await readingUnit(histogram.base, histogram.reading)),
        ...withDescription(await histogramDescription(histogram.base)),
      });
    }
  }
  return {
    keys: await withKinds(rows.map((row) => ({ k: String(row.k), n: number(row.n) }))),
    total: number(totals[0]?.total),
    picked: pickedOut,
  };
}
