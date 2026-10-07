import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { metricExpr } from "../shared/metric";
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

/**
 * Ingested samples, read by the kind the name came as: a counter is the sum of
 * what arrived in each bar, anything else the average of its points.
 * Unlabeled uses `metrics_by_minute`. Label matchers scan `metrics` (not
 * `logs`). Log `q` is never applied.
 */
export async function searchMetricSeries(opts: {
  from?: string;
  to?: string;
  since?: string;
  intervalMs: HistogramIntervalMs;
  name: string;
  labels: Record<string, string>;
  exact?: boolean;
  exclude?: { key: string; values: readonly string[] };
}): Promise<SearchAggResult> {
  const expr = metricExpr(opts.name, opts.labels);
  const interval = histogramIntervalSql(opts.intervalMs);
  const overlay = {
    from: tightenHistogramFrom(opts.from, opts.since, opts.intervalMs),
    to: opts.to,
    exact: opts.exact,
  };
  const labeled = Object.keys(opts.labels).length > 0;
  const counter = (await metricKind(opts.name)) === "counter";
  const rolled = counter ? "sumMerge(v_sum)" : "sumMerge(v_sum) / nullIf(countMerge(n), 0)";
  const scanned = counter ? "sum(value)" : "avg(value)";
  if (!opts.exact && !opts.exclude && !labeled && histogramUsesMinuteRollup(opts.intervalMs)) {
    const overlayWhere = metricTimeWhere("minute", overlay);
    overlayWhere.params.metric_name = opts.name;
    const statWhere = metricTimeWhere("minute", { from: opts.from, to: opts.to });
    statWhere.params.metric_name = opts.name;
    const namePred = "name = {metric_name:String}";
    const bucketQuery = `
      SELECT
        toStartOfInterval(minute, ${interval}) AS bucket,
        ${rolled} AS v
      FROM metrics_by_minute
      WHERE ${overlayWhere.sql} AND ${namePred}
      GROUP BY bucket
      ORDER BY bucket
    `;
    const statQuery = `
      SELECT ${rolled} AS v
      FROM metrics_by_minute
      WHERE ${statWhere.sql} AND ${namePred}
    `;
    return metricResult(expr, counter, bucketQuery, statQuery, overlayWhere.params, statWhere.params);
  }

  const overlayWhere = metricTimeWhere("ts", overlay);
  overlayWhere.params.metric_name = opts.name;
  const overlayParts = [overlayWhere.sql, "name = {metric_name:String}"];
  pushLabels(overlayParts, overlayWhere.params, opts.labels);
  const statWhere = metricTimeWhere("ts", { from: opts.from, to: opts.to, exact: opts.exact });
  statWhere.params.metric_name = opts.name;
  const statParts = [statWhere.sql, "name = {metric_name:String}"];
  pushLabels(statParts, statWhere.params, opts.labels);
  if (opts.exclude) {
    for (const [parts, params] of [[overlayParts, overlayWhere.params], [statParts, statWhere.params]] as const) {
      params.exclude_key = opts.exclude.key;
      params.exclude_values = JSON.stringify(opts.exclude.values);
      parts.push("labels[{exclude_key:String}] NOT IN JSONExtract({exclude_values:String}, 'Array(String)')");
    }
  }
  const bucketQuery = `
    SELECT
      toStartOfInterval(ts, ${interval}) AS bucket,
      ${scanned} AS v
    FROM metrics
    WHERE ${overlayParts.join(" AND ")}
    GROUP BY bucket
    ORDER BY bucket
  `;
  const statQuery = `
    SELECT ${scanned} AS v
    FROM metrics
    WHERE ${statParts.join(" AND ")}
  `;
  return metricResult(expr, counter, bucketQuery, statQuery, overlayWhere.params, statWhere.params);
}

async function metricResult(
  expr: string,
  counter: boolean,
  bucketQuery: string,
  statQuery: string,
  overlayParams: Record<string, string>,
  statParams: Record<string, string>,
): Promise<SearchAggResult> {
  const [rows, statRows] = await Promise.all([
    clickhouseQuery<{ bucket: string; v: string | number | null }>(
      bucketQuery,
      overlayParams,
    ),
    clickhouseQuery<{ v: string | number | null }>(statQuery, statParams),
  ]);
  const buckets: SearchAggResult["buckets"] = [];
  for (const row of rows) {
    const v = finiteNum(row.v);
    if (v === null) {
      continue;
    }
    buckets.push({ t: toIsoTimestamp(String(row.bucket)), v });
  }
  return {
    expr,
    source: "metric",
    buckets,
    stat: finiteNum(statRows[0]?.v),
    kind: counter ? "counter" : "gauge",
  };
}

export type MetricNameRow = { k: string; n: number; kind: MetricKind };

/** A name with no stored kind was posted as a plain point and reads as a gauge. */
async function withKinds(rows: Array<{ k: string; n: number }>): Promise<MetricNameRow[]> {
  const out: MetricNameRow[] = [];
  for (const row of rows) {
    out.push({ ...row, kind: (await metricKind(row.k)) ?? "gauge" });
  }
  return out;
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
    found = "AND positionCaseInsensitive(name, {find:String}) > 0";
  }
  const pickedParams: Record<string, string> = { ...params, picked: JSON.stringify(picked) };
  const number = (value: string | number | undefined) =>
    typeof value === "number" ? value : Number(value ?? 0);
  const [rows, totals, pickedRows] = await Promise.all([
    clickhouseQuery<{ k: string; n: string | number }>(
      `
    SELECT name AS k, countMerge(n) AS n
    FROM metrics_by_minute
    WHERE ${sql} AND name != '' ${found}
    GROUP BY k
    ORDER BY n DESC, k ASC
    LIMIT ${maxAttrKeys}
  `,
      listParams,
    ),
    clickhouseQuery<{ total: string | number }>(
      `SELECT uniqExact(name) AS total FROM metrics_by_minute WHERE ${sql} AND name != ''`,
      params,
    ),
    picked.length === 0
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
  return {
    keys: await withKinds(rows.map((row) => ({ k: String(row.k), n: number(row.n) }))),
    total: number(totals[0]?.total),
    picked: await withKinds(picked.map((name) => ({ k: name, n: withPoints.get(name) ?? 0 }))),
  };
}
