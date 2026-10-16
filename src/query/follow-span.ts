import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { followEdgeMs, followReachMs, type FollowSpan } from "../shared/follow-span";
import { emitQuerySql, QueryCompileError, requireCompiled } from "./compile";
import {
  isNumericAggBudgetError,
  logsScanBudgetRefuseReason,
  numericScanSettings,
} from "./agg";

type SpanRow = {
  n: string | number;
  first: string;
  last: string;
  past_before: string | number;
  past_after: string | number;
};

/**
 * A day either side of `at` (`from`/`to`), read an hour further (`outer_*`) to
 * tell a story cut at a day; `q` is the Follow tab's own `key:value`.
 */
export function followSpanWhere(
  q: string,
  atMs: number,
): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {
    tenant_id: "default",
    from: new Date(atMs - followReachMs).toISOString(),
    to: new Date(atMs + followReachMs).toISOString(),
    outer_from: new Date(atMs - followReachMs - followEdgeMs).toISOString(),
    outer_to: new Date(atMs + followReachMs + followEdgeMs).toISOString(),
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "ts >= parseDateTime64BestEffort({outer_from:String})",
    "ts <= parseDateTime64BestEffort({outer_to:String})",
  ];
  const sql = emitQuerySql(requireCompiled(q), params, "logs");
  if (sql) {
    where.push(sql);
  }
  return { sql: where.join(" AND "), params };
}

/**
 * One read under the scan budget: how many rows within a day, the first and
 * last of them, and whether the value is seen in the hour past either end.
 */
export async function searchFollowSpan(q: string, atMs: number): Promise<FollowSpan> {
  const { sql, params } = followSpanWhere(q, atMs);
  const query = `
    WITH
      ts >= parseDateTime64BestEffort({from:String})
        AND ts <= parseDateTime64BestEffort({to:String}) AS inside
    SELECT
      countIf(inside) AS n,
      minIf(ts, inside) AS first,
      maxIf(ts, inside) AS last,
      countIf(ts < parseDateTime64BestEffort({from:String})) AS past_before,
      countIf(ts > parseDateTime64BestEffort({to:String})) AS past_after
    FROM logs
    WHERE ${sql}
    ${numericScanSettings}
  `;
  let rows: SpanRow[];
  try {
    rows = await clickhouseQuery<SpanRow>(query, params);
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return { n: null, first: null, last: null, refused: logsScanBudgetRefuseReason };
    }
    throw err;
  }
  const row = rows[0];
  const n = Number(row?.n ?? 0);
  if (!row || !Number.isFinite(n) || n <= 0) {
    return { n: 0, first: null, last: null };
  }
  const span: FollowSpan = {
    n,
    first: toIsoTimestamp(String(row.first)),
    last: toIsoTimestamp(String(row.last)),
  };
  if (Number(row.past_before) > 0) {
    span.pastBefore = true;
  }
  if (Number(row.past_after) > 0) {
    span.pastAfter = true;
  }
  return span;
}

export async function followSpanRoute(c: Context): Promise<Response> {
  const q = c.req.query("q")?.trim() ?? "";
  const at = c.req.query("at") ?? "";
  const atMs = Date.parse(at);
  if (q.length === 0 || Number.isNaN(atMs)) {
    return c.json({ error: "q and at are required" }, 400);
  }
  try {
    return c.json(await searchFollowSpan(q, atMs));
  } catch (err) {
    if (err instanceof QueryCompileError) {
      return c.json({ error: err.message, faults: err.faults }, 400);
    }
    throw err;
  }
}
