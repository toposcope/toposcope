import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { parseLogEvent, type LogEvent, type LogLevel } from "../shared/log-event";
import { emitQuerySql, requireCompiled } from "./compile";

export const surroundingDefaultN = 50;
export const surroundingMaxN = 200;
export const surroundingStepN = 50;

export type SurroundingQuery = {
  ts: string;
  service: string;
  host?: string;
  n?: number;
  q?: string;
};

export type AroundTsQuery = {
  ts: string;
  from?: string;
  to?: string;
  q?: string;
  n?: number;
};

export type SurroundingResult = {
  before: LogEvent[];
  after: LogEvent[];
};

type LogRow = {
  ts: string;
  service: string;
  host: string;
  level: string;
  message: string;
  attrs: string;
};

export function clampSurroundingN(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) {
    return surroundingDefaultN;
  }
  return Math.min(surroundingMaxN, Math.max(1, Math.floor(n)));
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

/** Pivot is always this event's service (+ host). `q` ANDs the search bar (Matching). */
export function surroundingWhere(query: SurroundingQuery): {
  sql: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {
    tenant_id: "default",
    ts: query.ts,
    service: query.service,
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "service = {service:String}",
  ];
  if (query.host !== undefined && query.host.length > 0) {
    where.push("host = {host:String}");
    params.host = query.host;
  }
  const qsql = emitQuerySql(requireCompiled(query.q ?? ""), params, "logs");
  if (qsql) {
    where.push(qsql);
  }
  return { sql: where.join(" AND "), params };
}

/** Exclusive of the pivot timestamp — same-ms rows are not on either side. */
export const surroundingBeforeTsSql =
  "ts < parseDateTime64BestEffort({ts:String})";
export const surroundingAfterTsSql =
  "ts > parseDateTime64BestEffort({ts:String})";

/**
 * ClickHouse `before` is newest-first (`ORDER BY ts DESC`); paint wants oldest first.
 * `after` is already closest-newer first (`ORDER BY ts ASC`).
 */
export function assembleSurroundingSides<T>(
  beforeNewestFirst: readonly T[],
  afterOldestFirst: readonly T[],
): { before: T[]; after: T[] } {
  return {
    before: [...beforeNewestFirst].reverse(),
    after: [...afterOldestFirst],
  };
}

async function fetchSurroundingSides(
  whereSql: string,
  params: Record<string, string>,
): Promise<SurroundingResult> {
  const select = "SELECT ts, service, host, level, message, attrs FROM logs";
  const [beforeRows, afterRows] = await Promise.all([
    clickhouseQuery<LogRow>(
      `
      ${select}
      WHERE ${whereSql} AND ${surroundingBeforeTsSql}
      ORDER BY ts DESC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 30
    `,
      params,
    ),
    clickhouseQuery<LogRow>(
      `
      ${select}
      WHERE ${whereSql} AND ${surroundingAfterTsSql}
      ORDER BY ts ASC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 30
    `,
      params,
    ),
  ]);
  return assembleSurroundingSides(
    beforeRows.map(rowToLogEvent),
    afterRows.map(rowToLogEvent),
  );
}

/** Hunt window + `q` only — not a Surroundings service/host pivot. */
export function aroundSearchParams(query: AroundTsQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("ts", query.ts);
  params.set("n", String(clampSurroundingN(query.n)));
  if (query.from) {
    params.set("from", query.from);
  }
  if (query.to) {
    params.set("to", query.to);
  }
  const q = query.q?.trim();
  if (q) {
    params.set("q", q);
  }
  return params;
}

export function aroundWhere(query: AroundTsQuery): {
  sql: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {
    tenant_id: "default",
    ts: query.ts,
  };
  const where = ["tenant_id = {tenant_id:String}"];
  if (query.from) {
    where.push("ts >= parseDateTime64BestEffort({from:String})");
    params.from = query.from;
  }
  if (query.to) {
    where.push("ts <= parseDateTime64BestEffort({to:String})");
    params.to = query.to;
  }
  const qsql = emitQuerySql(requireCompiled(query.q ?? ""), params, "logs");
  if (qsql) {
    where.push(qsql);
  }
  return { sql: where.join(" AND "), params };
}

export async function searchAroundTs(
  query: AroundTsQuery,
): Promise<SurroundingResult> {
  const n = clampSurroundingN(query.n);
  const { sql, params } = aroundWhere(query);
  params.limit = String(n);
  return fetchSurroundingSides(sql, params);
}

export async function searchSurrounding(
  query: SurroundingQuery,
): Promise<SurroundingResult> {
  const n = clampSurroundingN(query.n);
  const { sql, params } = surroundingWhere(query);
  params.limit = String(n);
  return fetchSurroundingSides(sql, params);
}
