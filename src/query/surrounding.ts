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

export async function searchSurrounding(
  query: SurroundingQuery,
): Promise<SurroundingResult> {
  const n = clampSurroundingN(query.n);
  const { sql, params } = surroundingWhere(query);
  params.limit = String(n);
  const select = "SELECT ts, service, host, level, message, attrs FROM logs";
  const [beforeRows, afterRows] = await Promise.all([
    clickhouseQuery<LogRow>(
      `
      ${select}
      WHERE ${sql} AND ts < parseDateTime64BestEffort({ts:String})
      ORDER BY ts DESC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 30
    `,
      params,
    ),
    clickhouseQuery<LogRow>(
      `
      ${select}
      WHERE ${sql} AND ts > parseDateTime64BestEffort({ts:String})
      ORDER BY ts ASC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 30
    `,
      params,
    ),
  ]);
  return {
    before: beforeRows.map(rowToLogEvent).reverse(),
    after: afterRows.map(rowToLogEvent),
  };
}
