import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { fallbackChangeMarkId } from "../shared/change-mark";
import { buildCoverage, type Coverage, type CoverageInput } from "../shared/coverage";

/** Coverage reads the last 24 h, as Fields does (#391). */
export const COVERAGE_SPAN_MS = 86_400_000;

const settings = "SETTINGS max_execution_time = 8";

function num(v: string | number | undefined): number {
  return v === undefined ? 0 : Number(v);
}

/**
 * The SQL Coverage runs: the minute rollups, change_marks, and the service lists of spans and
 * metrics. None of it reads `logs`.
 */
export const coverageSql = {
  logs: `
    SELECT service,
      countMerge(n) AS rows,
      countMergeIf(n, host != '') AS host_rows,
      countMergeIf(n, level IN ('error', 'fatal')) AS error_rows
    FROM logs_by_minute
    WHERE tenant_id = 'default' AND minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))
    GROUP BY service
    ${settings}
  `,
  // A stacktrace usually also becomes frames on the way in, so a row can carry both: each minute
  // cell counts the larger of the two, never their sum.
  keys: `
    SELECT service, sum(v) AS version, sum(t) AS trace_id, sum(st) AS stack
    FROM (
      SELECT service,
        countMergeIf(n, key = 'version') AS v,
        countMergeIf(n, key = 'trace_id') AS t,
        if(level IN ('error', 'fatal'),
          greatest(countMergeIf(n, key = 'exception.stacktrace'), countMergeIf(n, key = 'exception.frames')),
          0) AS st
      FROM logs_attr_keys_by_minute
      WHERE tenant_id = 'default' AND minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))
        AND key IN ('version', 'trace_id', 'exception.stacktrace', 'exception.frames')
      GROUP BY minute, service, level, host
    )
    GROUP BY service
    ${settings}
  `,
  versions: `
    SELECT service, value, countMerge(n) AS n
    FROM logs_attr_values_by_minute
    WHERE tenant_id = 'default' AND minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))
      AND key = 'version'
    GROUP BY service, value
    ORDER BY n DESC
    LIMIT 50 BY service
    ${settings}
  `,
  deploys: `
    SELECT id, ts, service, title, attrs['version'] AS version
    FROM change_marks
    WHERE tenant_id = 'default' AND kind = 'deploy' AND ts >= parseDateTime64BestEffort({from:String})
    ORDER BY ts DESC
    LIMIT 1 BY if(id = '', concat(toString(ts), service, title), id)
    LIMIT 1000
    ${settings}
  `,
  spans: `
    SELECT service, count() AS n
    FROM spans
    WHERE tenant_id = 'default' AND ts >= parseDateTime64BestEffort({from:String})
    GROUP BY service
    ${settings}
  `,
  metrics: `
    SELECT labels['service'] AS service, uniqExact(name) AS names
    FROM metrics
    WHERE tenant_id = 'default' AND ts >= parseDateTime64BestEffort({from:String})
      AND mapContains(labels, 'service')
    GROUP BY service
    ${settings}
  `,
};

/** A side list that cannot be read in time drops out of Coverage (null), not the whole answer. */
async function maybe<T>(p: Promise<T[]>): Promise<T[] | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function readCoverage(now = Date.now()): Promise<Coverage> {
  const from = new Date(now - COVERAGE_SPAN_MS).toISOString();
  const to = new Date(now).toISOString();
  const params = { from };
  type N = string | number;
  const [logs, keys, versions, deploys, spans, metrics] = await Promise.all([
    clickhouseQuery<{ service: string; rows: N; host_rows: N; error_rows: N }>(coverageSql.logs, params),
    clickhouseQuery<{ service: string; version: N; trace_id: N; stack: N }>(coverageSql.keys, params),
    clickhouseQuery<{ service: string; value: string; n: N }>(coverageSql.versions, params),
    clickhouseQuery<{ id: string; ts: string; service: string; title: string; version: string }>(coverageSql.deploys, params),
    maybe(clickhouseQuery<{ service: string; n: N }>(coverageSql.spans, params)),
    maybe(clickhouseQuery<{ service: string; names: N }>(coverageSql.metrics, params)),
  ]);
  const input: CoverageInput = {
    from,
    to,
    logs: logs.map((r) => ({ service: r.service, rows: num(r.rows), host_rows: num(r.host_rows), error_rows: num(r.error_rows) })),
    keys: keys.map((r) => ({ service: r.service, version: num(r.version), trace_id: num(r.trace_id), stack: num(r.stack) })),
    versions: versions.map((r) => ({ service: r.service, value: r.value, n: num(r.n) })),
    deploys: deploys.map((r) => {
      const ts = toIsoTimestamp(r.ts);
      const id = r.id.trim() || fallbackChangeMarkId({ ts, kind: "deploy", service: r.service, title: r.title });
      return { id, ts, service: r.service, version: r.version };
    }),
    spans: spans?.map((r) => ({ service: r.service, n: num(r.n) })) ?? null,
    metrics: metrics?.map((r) => ({ service: r.service, names: num(r.names) })) ?? null,
  };
  return buildCoverage(input);
}

export async function coverageRoute(c: Context): Promise<Response> {
  return c.json(await readCoverage());
}
