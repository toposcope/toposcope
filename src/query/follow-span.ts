import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { followReachMs, type FollowSpan } from "../shared/follow-span";
import { emitQuerySql, QueryCompileError, requireCompiled } from "./compile";
import {
  isNumericAggBudgetError,
  logsScanBudgetRefuseReason,
  numericScanSettings,
} from "./agg";

type SpanRow = { n: string | number; first: string; last: string };

/** Within a day either side of `at`; `q` is the Follow tab's own `key:value`. */
export function followSpanWhere(
  q: string,
  atMs: number,
): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {
    tenant_id: "default",
    from: new Date(atMs - followReachMs).toISOString(),
    to: new Date(atMs + followReachMs).toISOString(),
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "ts >= parseDateTime64BestEffort({from:String})",
    "ts <= parseDateTime64BestEffort({to:String})",
  ];
  const sql = emitQuerySql(requireCompiled(q), params, "logs");
  if (sql) {
    where.push(sql);
  }
  return { sql: where.join(" AND "), params };
}

/** One read under the scan budget: how many rows, and the first and last of them. */
export async function searchFollowSpan(q: string, atMs: number): Promise<FollowSpan> {
  const { sql, params } = followSpanWhere(q, atMs);
  const query = `
    SELECT count() AS n, min(ts) AS first, max(ts) AS last
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
  const n = Number(rows[0]?.n ?? 0);
  if (!Number.isFinite(n) || n <= 0 || !rows[0]) {
    return { n: 0, first: null, last: null };
  }
  return {
    n,
    first: toIsoTimestamp(String(rows[0].first)),
    last: toIsoTimestamp(String(rows[0].last)),
  };
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
