import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { parseLogEvent, type LogEvent, type LogLevel } from "../shared/log-event";
import { incMetric } from "../metrics";
import {
  emitQuerySql,
  faultCol,
  omitField,
  requireCompiled,
  QueryCompileError,
  type CompiledQuery,
  type SqlTable,
} from "./compile";
import { maxAttrKeys, parseAttrFacets } from "../shared/attrs";
import { maxHbarN } from "../shared/widgets";
import { getFieldSkipKeys } from "../shared/field-skip";
import {
  InvalidMetricError,
  parseMetricLabels,
  requireMetricName,
} from "../shared/metric";
import {
  histogramIntervalMs,
  histogramIntervalSql,
  histogramUsesMinuteRollup,
  parseHistogramSplit,
  rollupSource,
  singleAttrKey,
  tightenHistogramFrom,
  type HistogramIntervalMs,
  type HistogramSplit,
} from "./histogram";
import { parseFacetOmitSelf } from "./facet-omit";
import { searchAroundTs, searchSurrounding } from "./surrounding";
import {
  eventLookbacksMs,
  eventSliceAtFloor,
  eventSliceFrom,
  skipSearchEvents,
  skipSearchHistogram,
} from "./event-page";
import { ingestedKind } from "./ingested";
import { searchMetricSeries, metricNames } from "./metric-series";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";
import {
  canUseNumericAgg,
  formatSearchAgg,
  InvalidAggError,
  isNumericAggBudgetError,
  LogsScanBudgetError,
  logsScanBudgetRefuseReason,
  numericBudgetRefuseReason,
  numericKeyRefuseReason,
  numericMergeSql,
  numericScanFiniteSql,
  numericScanMaxSeconds,
  numericScanSettings,
  numericScanSql,
  parseSearchAgg,
  rateFromHistogram,
  refusedAgg,
  windowSeconds,
  type SearchAgg,
  type SearchAggResult,
} from "./agg";

export type { AggBucket, SearchAggResult } from "./agg";

type LogRow = {
  ts: string;
  service: string;
  host: string;
  level: string;
  message: string;
  attrs: string;
};

type HistogramRow = {
  bucket: string;
  k?: string;
  level?: string;
  n: string | number;
};

type FacetRow = {
  v: string;
  n: string | number;
};

export type SearchFilters = {
  from?: string;
  to?: string;
  range?: string;
  q?: string;
  cursor?: string;
  since?: string;
  limit?: number;
  split?: HistogramSplit;
  step?: string;
  agg?: string;
  metric?: string;
  ml?: string;
  events?: string;
};

export type LevelCounts = Partial<Record<LogLevel, number>>;

export type HistogramBucket = {
  t: string;
  n: number;
  series: Record<string, number>;
  by_level: LevelCounts;
};

export type SearchScan = {
  source: "refused";
  reason: string;
  histogram: boolean;
  events: boolean;
};

export type SearchResult = {
  events: LogEvent[];
  histogram: HistogramBucket[];
  total: number;
  nextCursor: string | null;
  from: string | null;
  to: string | null;
  ingested?: boolean;
  agg?: SearchAggResult;
  scan?: SearchScan;
};

export type FacetValue = {
  v: string;
  n: number;
};

export type FacetField = "level" | "service" | "host";

export type Facets = Record<FacetField, FacetValue[]>;

const facetFields: FacetField[] = ["level", "service", "host"];
const facetLimit = 10;
const maxFacetLimit = maxHbarN;
const attrQuerySettings = "SETTINGS max_execution_time = 5";

type WhereClause = {
  sql: string;
  params: Record<string, string>;
};

export function resolveFilters(
  filters: SearchFilters,
  now = Date.now(),
): SearchFilters {
  let next = filters;
  if (filters.range) {
    const window = resolveRange(filters.range, now);
    if (!window) {
      throw new InvalidRangeError(filters.range);
    }
    next = { ...filters, from: window.from, to: window.to };
  }
  const clamped = clampSearchSpan(next.from, next.to);
  return { ...next, from: clamped.from, to: clamped.to };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return 100;
  }
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

function compiledFor(q: string | undefined, omit?: string): CompiledQuery {
  const compiled = requireCompiled(q ?? "");
  return omit ? omitField(compiled, omit) : compiled;
}

function sourceOf(compiled: CompiledQuery) {
  return rollupSource(compiled, getFieldSkipKeys());
}

function pushQuery(
  where: string[],
  params: Record<string, string>,
  compiled: CompiledQuery,
  table: SqlTable,
  attrKey?: string,
): void {
  const sql = emitQuerySql(compiled, params, table, attrKey);
  if (sql) {
    where.push(sql);
  }
}

function buildWhere(
  filters: SearchFilters,
  withCursor: boolean,
  omit?: string,
): WhereClause {
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  const compiled = compiledFor(filters.q, omit);

  if (filters.from) {
    where.push("ts >= parseDateTime64BestEffort({from:String})");
    params.from = filters.from;
  }
  if (filters.to) {
    where.push("ts <= parseDateTime64BestEffort({to:String})");
    params.to = filters.to;
  }
  if (withCursor && filters.cursor) {
    where.push("ts < parseDateTime64BestEffort({cursor:String})");
    params.cursor = filters.cursor;
  }
  if (filters.since) {
    where.push("ts >= parseDateTime64BestEffort({since:String})");
    params.since = filters.since;
  }
  pushQuery(where, params, compiled, "logs");

  return { sql: where.join(" AND "), params };
}

async function fetchLogPage(
  filters: SearchFilters,
  limit: number,
  timeoutSec: number,
  budget = false,
): Promise<LogEvent[]> {
  const { sql, params } = buildWhere(filters, true);
  const settings = budget
    ? numericScanSettings
    : `SETTINGS max_execution_time = ${Number.isFinite(timeoutSec) ? Math.max(1, Math.trunc(timeoutSec)) : 30}`;
  const query = `
    SELECT ts, service, host, level, message, attrs
    FROM logs
    WHERE ${sql}
    ORDER BY ts DESC
    LIMIT {limit:UInt32}
    ${settings}
  `;
  params.limit = String(limit);
  try {
    const rows = budget
      ? await clickhouseQueryBudgeted<LogRow>(query, params)
      : await clickhouseQuery<LogRow>(query, params);
    return rows.map(rowToLogEvent);
  } catch (err) {
    if (budget && isNumericAggBudgetError(err)) {
      throw new LogsScanBudgetError();
    }
    throw err;
  }
}

type EventPage = { events: LogEvent[]; refused?: string };

/** Newest-first page: widen lookback from `to`/`cursor` so CH prunes instead of sorting the whole window. */
async function searchLogPage(filters: SearchFilters): Promise<EventPage> {
  const resolved = resolveFilters(filters);
  const limit = clampLimit(resolved.limit);
  try {
    if (resolved.since) {
      return { events: await fetchLogPage(resolved, limit, 30) };
    }
    const upper = resolved.cursor ?? resolved.to;
    if (!upper) {
      return { events: await fetchLogPage(resolved, limit, 110, true) };
    }
    const originalFrom = resolved.from;
    let prevFrom: string | undefined;
    for (let i = 0; i < eventLookbacksMs.length; i++) {
      const lookback = eventLookbacksMs[i];
      if (lookback === undefined) {
        break;
      }
      const from = eventSliceFrom(originalFrom, upper, lookback);
      if (from === prevFrom) {
        continue;
      }
      prevFrom = from;
      const atFloor = eventSliceAtFloor(originalFrom, from);
      const last = i === eventLookbacksMs.length - 1;
      const rows = await fetchLogPage(
        { ...resolved, from },
        limit,
        atFloor || last ? 110 : 30,
        atFloor || last,
      );
      if (rows.length >= limit || atFloor || last) {
        return { events: rows };
      }
    }
    return { events: await fetchLogPage(resolved, limit, 110, true) };
  } catch (err) {
    if (err instanceof LogsScanBudgetError) {
      return { events: [], refused: err.message };
    }
    throw err;
  }
}

export async function searchLogs(filters: SearchFilters): Promise<LogEvent[]> {
  const page = await searchLogPage(filters);
  if (page.refused) {
    throw new LogsScanBudgetError(page.refused);
  }
  return page.events;
}

export async function countLogs(filters: SearchFilters): Promise<number> {
  const resolved = resolveFilters(filters);
  const compiled = compiledFor(resolved.q);
  const source = sourceOf(compiled);
  if (source === "minute") {
    const { sql, params } = buildMvWhere(resolved);
    const query = `SELECT countMerge(n) AS n FROM logs_by_minute WHERE ${sql}`;
    const rows = await clickhouseQuery<{ n: string | number }>(query, params);
    return rowCount(rows[0]?.n);
  }
  if (source === "attr") {
    const { sql, params } = buildAttrValuesWhere(resolved);
    const query = `SELECT countMerge(n) AS n FROM logs_attr_values_by_minute WHERE ${sql}`;
    const rows = await clickhouseQuery<{ n: string | number }>(query, params);
    return rowCount(rows[0]?.n);
  }
  const { sql, params } = buildWhere(resolved, false);
  const query = `SELECT count() AS n FROM logs WHERE ${sql}
    ${numericScanSettings}`;
  try {
    const rows = await clickhouseQueryBudgeted<{ n: string | number }>(
      query,
      params,
    );
    return rowCount(rows[0]?.n);
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      throw new LogsScanBudgetError();
    }
    throw err;
  }
}

function rowCount(n: string | number | undefined): number {
  if (n === undefined) {
    return 0;
  }
  return typeof n === "number" ? n : Number(n);
}

function buildMinuteWindow(filters: SearchFilters): WhereClause {
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  if (filters.from) {
    where.push(
      "minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))",
    );
    params.from = filters.from;
  }
  if (filters.to) {
    where.push(
      "minute <= toStartOfMinute(parseDateTime64BestEffort({to:String}))",
    );
    params.to = filters.to;
  }
  return { sql: where.join(" AND "), params };
}

function buildMvWhere(
  filters: SearchFilters,
  omit?: string,
): WhereClause {
  const { sql, params } = buildMinuteWindow(filters);
  const where = [sql];
  pushQuery(where, params, compiledFor(filters.q, omit), "minute");
  return { sql: where.join(" AND "), params };
}

function buildAttrValuesWhere(
  filters: SearchFilters,
  omit?: string,
): WhereClause {
  const compiled = compiledFor(filters.q, omit);
  const { sql, params } = buildMinuteWindow(filters);
  const where = [sql];
  const key = singleAttrKey(compiled);
  if (key) {
    params.attr_key = key;
    where.push("key = {attr_key:String}");
  }
  pushQuery(where, params, compiled, "attr", key);
  return { sql: where.join(" AND "), params };
}

const levels: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

function isLogLevel(value: string): value is LogLevel {
  return (levels as string[]).includes(value);
}

export function foldHistogramRows(rows: HistogramRow[]): HistogramBucket[] {
  const byBucket = new Map<string, HistogramBucket>();
  for (const row of rows) {
    const t = toIsoTimestamp(String(row.bucket));
    const n = typeof row.n === "number" ? row.n : Number(row.n);
    let bucket = byBucket.get(t);
    if (!bucket) {
      bucket = { t, n: 0, series: {}, by_level: {} };
      byBucket.set(t, bucket);
    }
    bucket.n += n;
    const key = (row.k ?? row.level ?? "").trim();
    if (key.length > 0) {
      bucket.series[key] = (bucket.series[key] ?? 0) + n;
    }
    const level = key.toLowerCase();
    if (isLogLevel(level)) {
      bucket.by_level[level] = (bucket.by_level[level] ?? 0) + n;
    }
  }
  return [...byBucket.values()].sort((a, b) => a.t.localeCompare(b.t));
}

const seriesCap = 8;

export function capHistogramSeries(
  buckets: HistogramBucket[],
  split: HistogramSplit,
): HistogramBucket[] {
  if (split === "level" || split === "none") {
    return buckets;
  }
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [key, n] of Object.entries(bucket.series)) {
      totals.set(key, (totals.get(key) ?? 0) + n);
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length <= seriesCap) {
    return buckets;
  }
  const keep = new Set(ranked.slice(0, seriesCap).map(([key]) => key));
  return buckets.map((bucket) => {
    const series: Record<string, number> = {};
    let other = 0;
    for (const [key, n] of Object.entries(bucket.series)) {
      if (keep.has(key)) {
        series[key] = n;
      } else {
        other += n;
      }
    }
    if (other > 0) {
      series.other = other;
    }
    return { ...bucket, series };
  });
}

function histogramKeySql(split: HistogramSplit): string | null {
  switch (split) {
    case "level":
      return "level";
    case "service":
      return "service";
    case "host":
      return "host";
    case "none":
      return null;
    default: {
      const _exhaustive: never = split;
      return _exhaustive;
    }
  }
}

export async function searchHistogram(
  filters: SearchFilters,
): Promise<HistogramBucket[]> {
  return (await searchHistogramPage(filters)).buckets;
}

type HistogramPage = { buckets: HistogramBucket[]; refused?: string };

async function searchHistogramPage(
  filters: SearchFilters,
): Promise<HistogramPage> {
  const resolved = resolveFilters(filters);
  const compiled = compiledFor(resolved.q);
  const split = parseHistogramSplit(resolved.split);
  const intervalMs = histogramIntervalMs(
    resolved.from,
    resolved.to,
    resolved.step,
  );
  const scoped = {
    ...resolved,
    from: tightenHistogramFrom(resolved.from, resolved.since, intervalMs),
    since: undefined,
  };
  const interval = histogramIntervalSql(intervalMs);
  const key = histogramKeySql(split);
  const source = sourceOf(compiled);
  const useMv =
    histogramUsesMinuteRollup(intervalMs) &&
    (source === "minute" || source === "attr");
  if (useMv) {
    const table =
      source === "minute" ? "logs_by_minute" : "logs_attr_values_by_minute";
    const { sql, params } =
      source === "minute"
        ? buildMvWhere(scoped)
        : buildAttrValuesWhere(scoped);
    const query = key
      ? `
      SELECT
        toStartOfInterval(minute, ${interval}) AS bucket,
        ${key} AS k,
        countMerge(n) AS n
      FROM ${table}
      WHERE ${sql}
      GROUP BY bucket, k
      ORDER BY bucket
    `
      : `
      SELECT
        toStartOfInterval(minute, ${interval}) AS bucket,
        countMerge(n) AS n
      FROM ${table}
      WHERE ${sql}
      GROUP BY bucket
      ORDER BY bucket
    `;
    const rows = await clickhouseQuery<HistogramRow>(query, params);
    return { buckets: finishHistogram(foldHistogramRows(rows), split) };
  }
  const { sql, params } = buildWhere(scoped, false);
  const query = key
    ? `
    SELECT
      toStartOfInterval(ts, ${interval}) AS bucket,
      ${key} AS k,
      count() AS n
    FROM logs
    WHERE ${sql}
    GROUP BY bucket, k
    ORDER BY bucket
    ${numericScanSettings}
  `
    : `
    SELECT
      toStartOfInterval(ts, ${interval}) AS bucket,
      count() AS n
    FROM logs
    WHERE ${sql}
    GROUP BY bucket
    ORDER BY bucket
    ${numericScanSettings}
  `;
  try {
    const rows = await clickhouseQueryBudgeted<HistogramRow>(query, params);
    return { buckets: finishHistogram(foldHistogramRows(rows), split) };
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return { buckets: [], refused: logsScanBudgetRefuseReason };
    }
    throw err;
  }
}

function finishHistogram(
  buckets: HistogramBucket[],
  split: HistogramSplit,
): HistogramBucket[] {
  const capped = capHistogramSeries(buckets, split);
  if (split !== "none") {
    return capped;
  }
  return capped.map((bucket) => ({
    ...bucket,
    series: { events: bucket.n },
  }));
}

function mapFacetRows(rows: FacetRow[]): FacetValue[] {
  return rows.map((row) => ({
    v: String(row.v),
    n: typeof row.n === "number" ? row.n : Number(row.n),
  }));
}

function clampFacetLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return facetLimit;
  }
  return Math.min(maxFacetLimit, Math.max(1, Math.floor(limit)));
}

async function facetValues(
  filters: SearchFilters,
  field: FacetField,
  limit = facetLimit,
  omitSelf = true,
): Promise<FacetValue[]> {
  const omit = omitSelf ? field : undefined;
  const compiled = compiledFor(filters.q, omit);
  const source = sourceOf(compiled);
  const take = clampFacetLimit(limit);
  if (field === "level" || field === "service" || field === "host") {
    if (source === "minute") {
      const { sql, params } = buildMvWhere(filters, omit);
      params.limit = String(take);
      const query = `
        SELECT ${field} AS v, countMerge(n) AS n
        FROM logs_by_minute
        WHERE ${sql} AND ${field} != ''
        GROUP BY v
        ORDER BY n DESC, v ASC
        LIMIT {limit:UInt32}
      `;
      return mapFacetRows(await clickhouseQuery<FacetRow>(query, params));
    }
    if (source === "attr") {
      const { sql, params } = buildAttrValuesWhere(filters, omit);
      params.limit = String(take);
      const query = `
        SELECT ${field} AS v, countMerge(n) AS n
        FROM logs_attr_values_by_minute
        WHERE ${sql} AND ${field} != ''
        GROUP BY v
        ORDER BY n DESC, v ASC
        LIMIT {limit:UInt32}
      `;
      return mapFacetRows(await clickhouseQuery<FacetRow>(query, params));
    }
  }
  const { sql, params } = buildWhere(filters, false, omit);
  params.limit = String(take);
  const query = `
    SELECT ${field} AS v, count() AS n
    FROM logs
    WHERE ${sql} AND ${field} != ''
    GROUP BY v
    ORDER BY n DESC, v ASC
    LIMIT {limit:UInt32}
  `;
  return mapFacetRows(await clickhouseQuery<FacetRow>(query, params));
}

export async function facets(
  filters: SearchFilters,
  limit?: number,
  omitSelf = true,
): Promise<Facets> {
  const resolved = resolveFilters(filters);
  const take = clampFacetLimit(limit);
  const entries = await Promise.all(
    facetFields.map(
      async (field) =>
        [field, await facetValues(resolved, field, take, omitSelf)] as const,
    ),
  );
  const result: Facets = { level: [], service: [], host: [] };
  for (const [field, values] of entries) {
    result[field] = values;
  }
  return result;
}

async function clickhouseQuerySoft<T>(
  sql: string,
  params: Record<string, string>,
): Promise<T[]> {
  try {
    return await clickhouseQuery<T>(sql, params);
  } catch (err) {
    console.error(err);
    return [];
  }
}

async function clickhouseQueryBudgeted<T>(
  sql: string,
  params: Record<string, string>,
): Promise<T[]> {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(),
    (numericScanMaxSeconds + 2) * 1000,
  );
  try {
    return await clickhouseQuery<T>(sql, params, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type AttrKeyCount = { k: string; n: number };

export async function attrKeys(filters: SearchFilters): Promise<AttrKeyCount[]> {
  const resolved = resolveFilters(filters);
  const compiled = compiledFor(resolved.q);
  if (sourceOf(compiled) === "minute") {
    const { sql, params } = buildMvWhere(resolved);
    const query = `
      SELECT key AS k, countMerge(n) AS n
      FROM logs_attr_keys_by_minute
      WHERE ${sql} AND key != ''
      GROUP BY k
      ORDER BY n DESC, k ASC
      LIMIT ${maxAttrKeys}
      ${attrQuerySettings}
    `;
    const rows = await clickhouseQuerySoft<{ k: string; n: string | number }>(
      query,
      params,
    );
    return rows.map((row) => ({
      k: String(row.k),
      n: typeof row.n === "number" ? row.n : Number(row.n),
    }));
  }
  const { sql, params } = buildWhere(resolved, false);
  const query = `
    SELECT arrayJoin(mapKeys(attr_map)) AS k, count() AS n
    FROM logs
    WHERE ${sql}
    GROUP BY k
    HAVING k != ''
    ORDER BY n DESC, k ASC
    LIMIT ${maxAttrKeys}
    ${attrQuerySettings}
  `;
  const rows = await clickhouseQuerySoft<{ k: string; n: string | number }>(
    query,
    params,
  );
  return rows.map((row) => ({
    k: String(row.k),
    n: typeof row.n === "number" ? row.n : Number(row.n),
  }));
}

async function attrFacetValues(
  filters: SearchFilters,
  key: string,
  limit = facetLimit,
  omitSelf = true,
): Promise<FacetValue[]> {
  const omit = omitSelf ? key : undefined;
  const compiled = compiledFor(filters.q, omit);
  const take = clampFacetLimit(limit);
  if (sourceOf(compiled) === "minute") {
    const { sql, params } = buildMvWhere(filters, omit);
    params.attr_key = key;
    params.limit = String(take);
    const query = `
      SELECT value AS v, countMerge(n) AS n
      FROM logs_attr_values_by_minute
      WHERE ${sql} AND key = {attr_key:String} AND value != ''
      GROUP BY v
      ORDER BY n DESC, v ASC
      LIMIT {limit:UInt32}
      ${attrQuerySettings}
    `;
    return mapFacetRows(await clickhouseQuerySoft<FacetRow>(query, params));
  }
  const { sql, params } = buildWhere(filters, false, omit);
  params.attr_key = key;
  params.limit = String(take);
  const query = `
    SELECT attr_map[{attr_key:String}] AS v, count() AS n
    FROM logs
    WHERE ${sql} AND attr_map[{attr_key:String}] != ''
    GROUP BY v
    ORDER BY n DESC, v ASC
    LIMIT {limit:UInt32}
    ${attrQuerySettings}
  `;
  return mapFacetRows(await clickhouseQuerySoft<FacetRow>(query, params));
}

export async function attrFacets(
  filters: SearchFilters,
  keys: string[],
  limit?: number,
  omitSelf = true,
): Promise<Record<string, FacetValue[]>> {
  const resolved = resolveFilters(filters);
  const take = clampFacetLimit(limit);
  const pinned = parseAttrFacets(keys.join(","));
  const entries = await Promise.all(
    pinned.map(
      async (key) =>
        [key, await attrFacetValues(resolved, key, take, omitSelf)] as const,
    ),
  );
  const result: Record<string, FacetValue[]> = {};
  for (const [key, values] of entries) {
    result[key] = values;
  }
  return result;
}

export async function attrPrefixValues(
  filters: SearchFilters,
  key: string,
  prefix: string,
): Promise<FacetValue[]> {
  const pinned = parseAttrFacets(key);
  const attrKey = pinned[0];
  if (!attrKey || prefix.length === 0) {
    return [];
  }
  const resolved = resolveFilters(filters);
  const compiled = compiledFor(resolved.q, attrKey);
  if (sourceOf(compiled) === "minute") {
    const { sql, params } = buildMvWhere(resolved, attrKey);
    params.attr_key = attrKey;
    params.prefix = prefix;
    const query = `
      SELECT value AS v, countMerge(n) AS n
      FROM logs_attr_values_by_minute
      WHERE ${sql}
        AND key = {attr_key:String}
        AND startsWith(value, {prefix:String})
        AND value != ''
      GROUP BY v
      ORDER BY n DESC, v ASC
      LIMIT ${facetLimit}
      ${attrQuerySettings}
    `;
    return mapFacetRows(await clickhouseQuerySoft<FacetRow>(query, params));
  }
  const { sql, params } = buildWhere(resolved, false, attrKey);
  params.attr_key = attrKey;
  params.prefix = prefix;
  const query = `
    SELECT attr_map[{attr_key:String}] AS v, count() AS n
    FROM logs
    WHERE ${sql}
      AND startsWith(attr_map[{attr_key:String}], {prefix:String})
      AND attr_map[{attr_key:String}] != ''
    GROUP BY v
    ORDER BY n DESC, v ASC
    LIMIT ${facetLimit}
    ${attrQuerySettings}
  `;
  return mapFacetRows(await clickhouseQuerySoft<FacetRow>(query, params));
}

export async function search(filters: SearchFilters): Promise<SearchResult> {
  const resolved = resolveFilters(filters);
  const timed = { ...resolved, range: undefined };
  const limit = clampLimit(timed.limit);
  const eventsOnly = skipSearchHistogram(timed);
  const skipEvents = skipSearchEvents(timed);
  const aggSpec = parseSearchAgg(timed.agg);
  const metricName = timed.metric?.trim()
    ? requireMetricName(timed.metric)
    : null;
  const metricLabels = metricName ? parseMetricLabels(timed.ml) : {};
  const intervalMs = histogramIntervalMs(
    timed.from,
    timed.to,
    timed.step,
  );
  const intervalSec = intervalMs / 1000;
  const [eventPage, histPage, overlay] = await Promise.all([
    skipEvents
      ? Promise.resolve<EventPage>({ events: [] })
      : searchLogPage({ ...timed, limit }),
    eventsOnly
      ? Promise.resolve<HistogramPage>({ buckets: [] })
      : searchHistogramPage(timed),
    eventsOnly
      ? Promise.resolve(undefined)
      : metricName
        ? searchMetricSeries({
            from: timed.from,
            to: timed.to,
            since: timed.since,
            intervalMs,
            name: metricName,
            labels: metricLabels,
          })
        : aggSpec && aggSpec.op !== "rate"
          ? searchNumericAgg(timed, intervalMs, aggSpec)
          : Promise.resolve(undefined as SearchAggResult | undefined),
  ]);
  const events = eventPage.events;
  const histogram = histPage.buckets;
  const total = eventsOnly
    ? 0
    : histogram.reduce((sum, bucket) => sum + bucket.n, 0);
  const oldest = events[events.length - 1];
  const nextCursor = events.length === limit && oldest ? oldest.ts : null;
  const kind = ingestedKind({
    eventsOnly,
    isDelta: Boolean(timed.since),
    total,
    eventCount: events.length,
  });
  const ingested =
    kind === "true"
      ? true
      : kind === "probe"
        ? await storeHasEvents()
        : undefined;
  const histRefused = histPage.refused;
  const eventsRefused = eventPage.refused;
  let agg = eventsOnly
    ? undefined
    : metricName
      ? overlay
      : aggSpec === null
        ? undefined
        : aggSpec.op === "rate"
          ? histRefused
            ? refusedAgg("rate", histRefused)
            : rateFromHistogram(
                histogram,
                intervalSec,
                windowSeconds(timed.from, timed.to),
              )
          : overlay;
  const scan =
    histRefused || eventsRefused
      ? {
          source: "refused" as const,
          reason: histRefused ?? eventsRefused ?? logsScanBudgetRefuseReason,
          histogram: Boolean(histRefused),
          events: Boolean(eventsRefused),
        }
      : undefined;
  return {
    events,
    histogram,
    total,
    nextCursor,
    from: resolved.from ?? null,
    to: resolved.to ?? null,
    ...(ingested !== undefined ? { ingested } : {}),
    ...(agg ? { agg } : {}),
    ...(scan ? { scan } : {}),
  };
}

function finiteNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildNumericWhere(filters: SearchFilters, key: string): WhereClause {
  const { sql, params } = buildMvWhere(filters);
  params.agg_key = key;
  return { sql: `${sql} AND key = {agg_key:String}`, params };
}

async function searchNumericAgg(
  filters: SearchFilters,
  intervalMs: HistogramIntervalMs,
  agg: Exclude<SearchAgg, { op: "rate" }>,
): Promise<SearchAggResult | undefined> {
  const expr = formatSearchAgg(agg);
  const keyReason = numericKeyRefuseReason(agg.key, getFieldSkipKeys());
  if (keyReason) {
    return refusedAgg(expr, keyReason);
  }
  const compiled = compiledFor(filters.q);
  if (canUseNumericAgg(compiled) && histogramUsesMinuteRollup(intervalMs)) {
    return searchNumericMvAgg(filters, intervalMs, agg, expr);
  }
  if (filters.since) {
    return undefined;
  }
  return searchNumericLogsAgg(filters, intervalMs, agg, expr);
}

async function searchNumericMvAgg(
  filters: SearchFilters,
  intervalMs: HistogramIntervalMs,
  agg: Exclude<SearchAgg, { op: "rate" }>,
  expr: string,
): Promise<SearchAggResult> {
  const interval = histogramIntervalSql(intervalMs);
  const merge = numericMergeSql(agg.op);
  const overlay = {
    ...filters,
    from: tightenHistogramFrom(filters.from, filters.since, intervalMs),
    since: undefined,
  };
  const overlayWhere = buildNumericWhere(overlay, agg.key);
  const statWhere = buildNumericWhere({ ...filters, since: undefined }, agg.key);
  const bucketQuery = `
    SELECT
      toStartOfInterval(minute, ${interval}) AS bucket,
      ${merge} AS v
    FROM logs_attr_numeric_by_minute
    WHERE ${overlayWhere.sql}
    GROUP BY bucket
    ORDER BY bucket
    ${attrQuerySettings}
  `;
  const statQuery = `
    SELECT ${merge} AS v
    FROM logs_attr_numeric_by_minute
    WHERE ${statWhere.sql}
    ${attrQuerySettings}
  `;
  const [rows, statRows] = await Promise.all([
    clickhouseQuery<{ bucket: string; v: string | number | null }>(
      bucketQuery,
      overlayWhere.params,
    ),
    clickhouseQuery<{ v: string | number | null }>(statQuery, statWhere.params),
  ]);
  return numericAggFromRows(expr, rows, statRows[0]?.v);
}

async function searchNumericLogsAgg(
  filters: SearchFilters,
  intervalMs: HistogramIntervalMs,
  agg: Exclude<SearchAgg, { op: "rate" }>,
  expr: string,
): Promise<SearchAggResult> {
  const interval = histogramIntervalSql(intervalMs);
  const overlay = {
    ...filters,
    from: tightenHistogramFrom(filters.from, filters.since, intervalMs),
    since: undefined,
  };
  const overlayWhere = buildWhere(overlay, false);
  overlayWhere.params.agg_key = agg.key;
  const statWhere = buildWhere({ ...filters, since: undefined }, false);
  statWhere.params.agg_key = agg.key;
  const finite = numericScanFiniteSql();
  const reduce = numericScanSql(agg.op);
  const bucketQuery = `
    SELECT
      toStartOfInterval(ts, ${interval}) AS bucket,
      ${reduce} AS v
    FROM logs
    WHERE ${overlayWhere.sql}
      AND ${finite}
    GROUP BY bucket
    ORDER BY bucket
    ${numericScanSettings}
  `;
  const statQuery = `
    SELECT ${reduce} AS v
    FROM logs
    WHERE ${statWhere.sql}
      AND ${finite}
    ${numericScanSettings}
  `;
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(),
    (numericScanMaxSeconds + 2) * 1000,
  );
  try {
    const [rows, statRows] = await Promise.all([
      clickhouseQuery<{ bucket: string; v: string | number | null }>(
        bucketQuery,
        overlayWhere.params,
        { signal: ac.signal },
      ),
      clickhouseQuery<{ v: string | number | null }>(
        statQuery,
        statWhere.params,
        { signal: ac.signal },
      ),
    ]);
    return numericAggFromRows(expr, rows, statRows[0]?.v);
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return refusedAgg(expr, numericBudgetRefuseReason);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function numericAggFromRows(
  expr: string,
  rows: ReadonlyArray<{ bucket: string; v: string | number | null }>,
  statRaw: string | number | null | undefined,
): SearchAggResult {
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
    source: "numeric",
    buckets,
    stat: finiteNum(statRaw),
  };
}

export async function numericKeys(
  filters: SearchFilters,
): Promise<AttrKeyCount[]> {
  const resolved = resolveFilters(filters);
  const compiled = compiledFor(resolved.q);
  if (!canUseNumericAgg(compiled)) {
    return [];
  }
  const { sql, params } = buildMvWhere(resolved);
  const query = `
    SELECT key AS k, countMerge(n) AS n
    FROM logs_attr_numeric_by_minute
    WHERE ${sql} AND key != ''
    GROUP BY k
    ORDER BY n DESC, k ASC
    LIMIT ${maxAttrKeys}
    ${attrQuerySettings}
  `;
  const rows = await clickhouseQuerySoft<{ k: string; n: string | number }>(
    query,
    params,
  );
  return rows.map((row) => ({
    k: String(row.k),
    n: typeof row.n === "number" ? row.n : Number(row.n),
  }));
}

async function storeHasEvents(): Promise<boolean> {
  const rows = await clickhouseQuery<{ ok: string | number }>(
    `SELECT 1 AS ok FROM logs WHERE tenant_id = {tenant_id:String} LIMIT 1`,
    { tenant_id: "default" },
  );
  return rows.length > 0;
}

function rowToLogEvent(row: LogRow): LogEvent {
  let attrs: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(row.attrs || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      attrs = parsed as Record<string, unknown>;
    }
  } catch {
    attrs = undefined;
  }

  const host = row.host.trim() === "" ? undefined : row.host;
  return parseLogEvent({
    ts: toIsoTimestamp(String(row.ts)),
    service: row.service,
    host,
    level: row.level as LogLevel,
    message: row.message,
    attrs,
  });
}

function queryHttpError(c: Context, err: unknown): Response | null {
  if (
    err instanceof InvalidRangeError ||
    err instanceof InvalidAggError ||
    err instanceof InvalidMetricError
  ) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof QueryCompileError) {
    return c.json(
      {
        error: err.message,
        faults: err.faults.map((f) => ({ col: faultCol(f.at), msg: f.msg })),
      },
      400,
    );
  }
  return null;
}

function searchFiltersFrom(c: Context): SearchFilters {
  return {
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    range: c.req.query("range") ?? undefined,
    q: c.req.query("q") ?? undefined,
  };
}

export async function facetsRoute(c: Context): Promise<Response> {
  try {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const omitSelf = parseFacetOmitSelf(c.req.query("omit"));
    return c.json(await facets(searchFiltersFrom(c), limit, omitSelf));
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function attrKeysRoute(c: Context): Promise<Response> {
  try {
    return c.json({ keys: await attrKeys(searchFiltersFrom(c)) });
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function attrFacetsRoute(c: Context): Promise<Response> {
  try {
    const keys = parseAttrFacets(c.req.query("attrs"));
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const omitSelf = parseFacetOmitSelf(c.req.query("omit"));
    return c.json(await attrFacets(searchFiltersFrom(c), keys, limit, omitSelf));
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function attrValuesRoute(c: Context): Promise<Response> {
  try {
    const key = c.req.query("key") ?? "";
    const prefix = c.req.query("prefix") ?? "";
    return c.json({
      values: await attrPrefixValues(searchFiltersFrom(c), key, prefix),
    });
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function numericKeysRoute(c: Context): Promise<Response> {
  try {
    return c.json({ keys: await numericKeys(searchFiltersFrom(c)) });
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function metricNamesRoute(c: Context): Promise<Response> {
  try {
    const resolved = resolveFilters({
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      range: c.req.query("range") ?? undefined,
    });
    return c.json({
      keys: await metricNames({ from: resolved.from, to: resolved.to }),
    });
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function searchRoute(c: Context): Promise<Response> {
  const from = c.req.query("from") ?? undefined;
  const to = c.req.query("to") ?? undefined;
  const range = c.req.query("range") ?? undefined;
  const q = c.req.query("q") ?? undefined;
  const cursor = c.req.query("cursor") ?? undefined;
  const since = c.req.query("since") ?? undefined;
  const split = parseHistogramSplit(c.req.query("split") ?? undefined);
  const step = c.req.query("step") ?? undefined;
  const agg = c.req.query("agg") ?? undefined;
  const metric = c.req.query("metric") ?? undefined;
  const ml = c.req.query("ml") ?? undefined;
  const events = c.req.query("events") ?? undefined;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  incMetric("search_requests");
  try {
    const result = await search({
      from,
      to,
      range,
      q,
      cursor,
      since,
      limit,
      split,
      step,
      agg,
      metric,
      ml,
      events,
    });
    return c.json(result);
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function aroundTsRoute(c: Context): Promise<Response> {
  const ts = c.req.query("ts") ?? "";
  if (ts.length === 0 || Number.isNaN(Date.parse(ts))) {
    return c.json({ error: "ts is required" }, 400);
  }
  const nRaw = c.req.query("n");
  const n = nRaw ? Number(nRaw) : undefined;
  const q = c.req.query("q") ?? undefined;
  try {
    const result = await searchAroundTs({
      ts,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      n,
      q: q && q.trim().length > 0 ? q : undefined,
    });
    return c.json(result);
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}

export async function surroundingRoute(c: Context): Promise<Response> {
  const ts = c.req.query("ts") ?? "";
  const service = c.req.query("service") ?? "";
  if (ts.length === 0 || service.length === 0) {
    return c.json({ error: "ts and service are required" }, 400);
  }
  const nRaw = c.req.query("n");
  const n = nRaw ? Number(nRaw) : undefined;
  const host = c.req.query("host") ?? undefined;
  const q = c.req.query("q") ?? undefined;
  try {
    const result = await searchSurrounding({
      ts,
      service,
      host: host && host.length > 0 ? host : undefined,
      n,
      q: q && q.trim().length > 0 ? q : undefined,
    });
    return c.json(result);
  } catch (err) {
    return queryHttpError(c, err) ?? Promise.reject(err);
  }
}
