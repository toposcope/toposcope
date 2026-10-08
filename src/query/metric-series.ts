import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { bucketQuantile, bucketSums } from "../shared/histogram-quantile";
import {
  defaultHistogramReading,
  metricExpr,
  readingQuantile,
  type HistogramReading,
} from "../shared/metric";
import { metricKind, type MetricKind } from "../shared/metric-kinds";
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

function pushLabels(
  where: string[],
  params: Record<string, string>,
  labels: Record<string, string>,
): void {
  let i = 0;
  for (const [key, value] of Object.entries(labels)) {
    params[`mlk${i}`] = key;
    params[`mlv${i}`] = value;
    where.push(`labels[{mlk${i}:String}] = {mlv${i}:String}`);
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
};

/**
 * The bars asked for and the whole window, for its one number. Unlabeled bars
 * of a minute or more read the minute rollup; label matchers and finer bars
 * scan the stored points.
 */
function seriesWindows(opts: SeriesOpts): { rolled: boolean; overlay: WhereClause; stat: WhereClause } {
  const overlay = {
    from: tightenHistogramFrom(opts.from, opts.since, opts.intervalMs),
    to: opts.to,
    exact: opts.exact,
  };
  const labeled = Object.keys(opts.labels).length > 0;
  if (!opts.exact && !opts.exclude && !labeled && histogramUsesMinuteRollup(opts.intervalMs)) {
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
      parts.push("labels[{exclude_key:String}] NOT IN JSONExtract({exclude_values:String}, 'Array(String)')");
    }
    where.sql = parts.join(" AND ");
  }
  return windows;
}

/** What a result says about itself, beside its bars. */
type Told = Pick<SearchAggResult, "expr" | "kind" | "reading" | "metric">;

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
    };
    const q = readingQuantile(histogram.reading);
    if (q !== null) {
      return quantileSeries(opts, histogram.base, q, told);
    }
    const count = `${histogram.base}.count`;
    const sum = `${histogram.base}.sum`;
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
  const told: Told = { expr: metricExpr(opts.name, opts.labels), kind: counter ? "counter" : "gauge" };
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

async function valueSeries(opts: SeriesOpts, told: Told, read: ValueRead): Promise<SearchAggResult> {
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
};

/** A name with no stored kind was posted as a plain point and reads as a gauge. */
async function withKinds(rows: Array<{ k: string; n: number }>): Promise<MetricNameRow[]> {
  const out: MetricNameRow[] = [];
  for (const row of rows) {
    out.push({ ...row, kind: (await metricKind(row.k)) ?? "gauge" });
  }
  return out;
}

/** The names kept as histograms. */
const histogramNamesSql = `
  SELECT name FROM metric_kinds
  WHERE tenant_id = {tenant_id:String}
  GROUP BY name
  HAVING argMax(kind, seen) = 'histogram'
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
      pickedOut.push({ k: name, n, kind: (await metricKind(name)) ?? "gauge" });
    } else if (histogram.base === name) {
      pickedOut.push({ k: name, n, kind: "histogram" });
    } else {
      pickedOut.push({ k: name, n, kind: "histogram", of: histogram.base, reading: histogram.reading });
    }
  }
  return {
    keys: await withKinds(rows.map((row) => ({ k: String(row.k), n: number(row.n) }))),
    total: number(totals[0]?.total),
    picked: pickedOut,
  };
}
