import { withArrivalSeq } from "../ingest/arrival-seq";
import { withInsertSlot } from "../ingest/backpressure";
import { clickhouseInsertJsonEachRow, clickhouseQuery, toClickHouseDateTime } from "../shared/clickhouse";
import { hereName } from "../shared/here";
import { laneColumns } from "../shared/monitor";

/** One result as Watch draws it (#177): a tick at its time, a bar back to its `/start`. */
export type PushResultRow = {
  /** Its position from the one counter (#324). */
  id: number;
  monitor_id: string;
  at: number;
  result: "ok" | "warn" | "fail";
  exit_code: number | null;
  duration_ms: number | null;
  value: number | null;
  unit: string | null;
  message: string;
  host: string;
  via: string;
  /** The service its monitor is about (#335). */
  service?: string;
};

type ResultSqlRow = Omit<PushResultRow, "id" | "at"> & { id: string | number; at_ms: string | number };

/** How bad a result is: within a minute the worst is kept, and of equals the later. */
const rank = "multiIf(result = 'fail', 2, result = 'warn', 1, 0)";
// `at_ms`, not `at`: an alias named like the column would be what `toStartOfMinute(at)` reads.
const cols = "seq AS id, monitor_id, toUnixTimestamp64Milli(at) AS at_ms, result, exit_code, duration_ms, value, unit, message, host, via";
/** A message as a lane's tick carries it; the whole one is its log row. */
const tickMessage = 300;

function fromSql({ at_ms, ...row }: ResultSqlRow): PushResultRow {
  return { ...row, id: Number(row.id), at: Number(at_ms) };
}

/** A result for Watch's ticks (#324: in ClickHouse, with a position, so it travels over a link). */
export async function recordPushResult(row: Omit<PushResultRow, "id">): Promise<void> {
  await recordPushResults([row]);
}

/** Several results in one insert, numbered in the order given. */
export async function recordPushResults(rows: ReadonlyArray<Omit<PushResultRow, "id">>): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await withInsertSlot(() =>
    withArrivalSeq(rows.length, (from, arrived) =>
      clickhouseInsertJsonEachRow(
        rows
          .map((row, i) =>
            JSON.stringify({
              tenant_id: "default",
              monitor_id: row.monitor_id,
              at: toClickHouseDateTime(new Date(row.at).toISOString()),
              result: row.result,
              exit_code: row.exit_code,
              duration_ms: row.duration_ms,
              value: row.value,
              unit: row.unit,
              message: row.message,
              host: row.host,
              via: row.via,
              service: row.service ?? "",
              seq: from + i,
              arrived,
              toposcope: hereName(),
            }),
          )
          .join("\n"),
        "monitor_results",
      ),
    ),
    rows.length,
  );
}

/** A push monitor's last result as Watch keeps it: the worst of its last minute. */
export async function lastPushResult(monitorId: string): Promise<PushResultRow | null> {
  const rows = await clickhouseQuery<ResultSqlRow>(
    `SELECT ${cols} FROM monitor_results
     WHERE tenant_id = 'default' AND monitor_id = {id:String}
     ORDER BY toStartOfMinute(at) DESC, ${rank} DESC, at DESC, seq DESC
     LIMIT 1`,
    { id: monitorId },
  );
  return rows[0] ? fromSql(rows[0]) : null;
}

/**
 * Results in [from, to] for Watch's lanes, cut into 240 columns a monitor: each minute keeps its
 * worst result, then each column that has any is the worst of those, the later of equals.
 */
export async function resultsBetween(fromMs: number, toMs: number): Promise<PushResultRow[]> {
  const span = Math.max(1, toMs - fromMs);
  const rows = await clickhouseQuery<ResultSqlRow>(
    `SELECT id, monitor_id, at_ms, result, exit_code, duration_ms, value, unit, message, host, via FROM (
       SELECT *, row_number() OVER (
         PARTITION BY monitor_id, least(${laneColumns - 1}, intDiv((at_ms - {from:Int64}) * ${laneColumns}, {span:Int64}))
         ORDER BY r DESC, at_ms DESC, id DESC
       ) AS c FROM (
         SELECT ${cols}, ${rank} AS r, row_number() OVER (
           PARTITION BY monitor_id, toStartOfMinute(at) ORDER BY ${rank} DESC, at DESC, seq DESC
         ) AS m
         FROM monitor_results
         WHERE tenant_id = 'default'
           AND at >= fromUnixTimestamp64Milli({from:Int64}) AND at <= fromUnixTimestamp64Milli({to:Int64})
       ) WHERE m = 1
     ) WHERE c = 1 ORDER BY monitor_id, at_ms`,
    { from: String(fromMs), to: String(toMs), span: String(span) },
  );
  return rows.map((sql) => {
    const row = fromSql(sql);
    return row.message.length > tickMessage ? { ...row, message: `${row.message.slice(0, tickMessage)}…` } : row;
  });
}
