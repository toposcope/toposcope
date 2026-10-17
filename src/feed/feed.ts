import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { getDb } from "../control/index";
import { getRetentionDays } from "../control/settings";
import { arrivalSeqSettled } from "../ingest/arrival-seq";
import {
  clickhouseCommand,
  clickhouseQuery,
  toIsoTimestamp,
} from "../shared/clickhouse";
import { emitQuerySql, QueryCompileError, compileQuery, requireCompiled } from "../query/compile";
import {
  isNumericAggBudgetError,
  logsScanBudgetRefuseReason,
  numericScanSettings,
} from "../query/agg";

/**
 * A feed (#135): rows by arrival, through one `q`. A reader asks for what arrived after the last
 * position it has and gets the rows that match, as they are stored, `e1` included. The reply
 * always says what it covered, so caught up, behind and a hole cannot be mistaken for each other.
 */

/** Positions read in one call, at most: a sparse `q` still moves forward in steps this long. */
export const feedSpan = 100_000;
export const feedDefaultLimit = 1_000;
export const feedMaxLimit = 5_000;

export type Feed = { id: string; q: string; created_at: number };

export type FeedRow = {
  seq: number;
  ts: string;
  service: string;
  host: string;
  level: string;
  message: string;
  attrs: Record<string, string>;
  toposcope: string;
};

export type FeedReply = {
  feed: string;
  q: string;
  /** The range read: positions after `after`, through `through`. */
  after: number;
  through: number;
  rows: FeedRow[];
  /** Every row at or below this can be read; nothing above it is promised yet. */
  settled: number;
  /** When the row at the end of the range arrived here; null for an empty range. */
  arrived: string | null;
  /** The oldest position still stored; null when nothing is. */
  oldest: number | null;
  /** Rows whose time is older than this are gone under retention. */
  horizon: string;
  /** Positions retention passed before they were read: a hole, closed at both ends. */
  gone: { from: number; to: number } | null;
  refused?: string;
};

/**
 * Which positions one call reads: after `after`, through the end of a span or what is settled,
 * whichever comes first. Positions below the oldest still stored are gone, and say so.
 */
export function feedRange(input: {
  after: number;
  settled: number;
  oldest: number | null;
  span?: number;
}): { through: number; gone: { from: number; to: number } | null } {
  const through = Math.max(input.after, Math.min(input.settled, input.after + (input.span ?? feedSpan)));
  const gone =
    input.oldest !== null && input.after + 1 < input.oldest
      ? { from: input.after + 1, to: input.oldest - 1 }
      : null;
  return { through, gone };
}

type FeedSqlRow = {
  seq: string | number;
  ts: string;
  service: string;
  host: string;
  level: string;
  message: string;
  attrs: string;
  toposcope: string;
};

function parseAttrs(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

let oldestCache: { at: number; value: number | null } | null = null;
const oldestTtlMs = 60_000;

/** The oldest position still stored. A full read of `seq`, so it is kept for a minute. */
async function oldestPosition(now = Date.now()): Promise<number | null> {
  if (oldestCache && now - oldestCache.at < oldestTtlMs) {
    return oldestCache.value;
  }
  const rows = await clickhouseQuery<{ n: string | number; c: string | number }>(
    "SELECT min(seq) AS n, count() AS c FROM logs WHERE seq > 0",
  );
  const value = Number(rows[0]?.c ?? 0) > 0 ? Number(rows[0]?.n) : null;
  oldestCache = { at: now, value };
  return value;
}

/** Tests only. */
export function forgetOldestPosition(): void {
  oldestCache = null;
}

/** The rows of `(after, through]` that match `q`, in arrival order, at most `limit`. */
export async function readFeed(input: {
  id: string;
  q: string;
  after: number;
  limit?: number;
  settled?: number;
  retentionDays?: number;
  now?: number;
}): Promise<FeedReply> {
  const now = input.now ?? Date.now();
  const limit = Math.min(feedMaxLimit, Math.max(1, Math.floor(input.limit ?? feedDefaultLimit)));
  const settled = input.settled ?? arrivalSeqSettled();
  const oldest = await oldestPosition(now);
  const range = feedRange({ after: input.after, settled, oldest });
  const horizon = new Date(now - (input.retentionDays ?? 30) * 86_400_000).toISOString();
  const base: Omit<FeedReply, "through" | "rows" | "arrived"> = {
    feed: input.id,
    q: input.q,
    after: input.after,
    settled,
    oldest,
    horizon,
    gone: range.gone,
  };
  if (range.through <= input.after) {
    return { ...base, through: input.after, rows: [], arrived: null };
  }
  const params: Record<string, string> = {
    tenant_id: "default",
    after: String(input.after),
    through: String(range.through),
    limit: String(limit),
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "seq > {after:UInt64}",
    "seq <= {through:UInt64}",
  ];
  const qsql = emitQuerySql(requireCompiled(input.q), params, "logs");
  if (qsql) {
    where.push(qsql);
  }
  let rows: FeedSqlRow[];
  try {
    rows = await clickhouseQuery<FeedSqlRow>(
      `
      SELECT seq, ts, service, host, level, message, attrs, toposcope
      FROM logs
      WHERE ${where.join(" AND ")}
      ORDER BY seq
      LIMIT {limit:UInt32}
      ${numericScanSettings}
    `,
      params,
    );
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return { ...base, through: input.after, rows: [], arrived: null, refused: logsScanBudgetRefuseReason };
    }
    throw err;
  }
  const out = rows.map((row) => ({
    seq: Number(row.seq),
    ts: toIsoTimestamp(String(row.ts)),
    service: row.service,
    host: row.host,
    level: row.level,
    message: row.message,
    attrs: parseAttrs(row.attrs),
    toposcope: row.toposcope,
  }));
  // A full page ends at its last row; otherwise the whole range was read.
  const through = out.length === limit ? out[out.length - 1]!.seq : range.through;
  const arrivedRows = await clickhouseQuery<{ a: string; c: string | number }>(
    `SELECT max(arrived) AS a, count() AS c FROM logs
     WHERE tenant_id = {tenant_id:String} AND seq > {after:UInt64} AND seq <= {through:UInt64}`,
    { tenant_id: "default", after: String(input.after), through: String(through) },
  );
  const arrived =
    Number(arrivedRows[0]?.c ?? 0) > 0 ? toIsoTimestamp(String(arrivedRows[0]!.a)) : null;
  return { ...base, through, rows: out, arrived };
}

/**
 * A projection ordered by `seq` makes any range cheap however old (measured: 50k positions deep
 * in 15M rows read about 0.9M rows with it, 7.5M without). Built when the first feed exists.
 */
export async function ensureSeqProjection(): Promise<void> {
  const rows = await clickhouseQuery<{ name: string }>(
    `SELECT name FROM system.projections WHERE database = currentDatabase() AND table = 'logs' AND name = 'by_seq'`,
  ).catch(() => [] as { name: string }[]);
  if (rows.length > 0) {
    return;
  }
  await clickhouseCommand(
    "ALTER TABLE logs ADD PROJECTION IF NOT EXISTS by_seq (SELECT seq, _part_offset ORDER BY seq)",
  );
  await clickhouseCommand("ALTER TABLE logs MATERIALIZE PROJECTION by_seq");
}

function feedId(): string {
  return `f_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function listFeeds(db: Database = getDb()): Feed[] {
  return db.query("SELECT id, q, created_at FROM feeds ORDER BY created_at").all() as Feed[];
}

export function getFeed(id: string, db: Database = getDb()): Feed | null {
  return (db.query("SELECT id, q, created_at FROM feeds WHERE id = ?").get(id) as Feed | undefined) ?? null;
}

/** The `q` is compiled now and refused now; a feed's filter never changes after this. */
export function defineFeed(q: string, db: Database = getDb()): Feed | { faults: unknown[]; error: string } {
  const text = q.trim();
  const compiled = compileQuery(text);
  if (compiled.faults.length > 0) {
    return { error: compiled.faults[0]?.msg ?? "q does not compile", faults: compiled.faults };
  }
  const feed = { id: feedId(), q: text, created_at: Date.now() };
  db.query("INSERT INTO feeds (id, q, created_at) VALUES (?, ?, ?)").run(feed.id, feed.q, feed.created_at);
  return feed;
}

export async function createFeedRoute(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON { q }" }, 400);
  }
  const q = (body as { q?: unknown } | null)?.q;
  if (typeof q !== "string") {
    return c.json({ error: "q is required (empty means every row)" }, 400);
  }
  const first = listFeeds().length === 0;
  const feed = defineFeed(q);
  if ("faults" in feed) {
    return c.json(feed, 400);
  }
  if (first) {
    await ensureSeqProjection();
  }
  return c.json(feed, 201);
}

export function listFeedsRoute(c: Context): Response {
  return c.json({ feeds: listFeeds() });
}

export async function readFeedRoute(c: Context): Promise<Response> {
  const feed = getFeed(c.req.param("id") ?? "");
  if (!feed) {
    return c.json({ error: "no such feed" }, 404);
  }
  const after = Number(c.req.query("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) {
    return c.json({ error: "after is a position: a whole number, 0 or more" }, 400);
  }
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  try {
    return c.json(
      await readFeed({ id: feed.id, q: feed.q, after, limit, retentionDays: getRetentionDays() }),
    );
  } catch (err) {
    if (err instanceof QueryCompileError) {
      return c.json({ error: err.message, faults: err.faults }, 400);
    }
    throw err;
  }
}
