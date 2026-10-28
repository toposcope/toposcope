import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { getDb } from "../control/index";
import { instanceId } from "../control/instance";
import { effectiveMetricsRetentionDays, getRetentionDays } from "../control/settings";
import { arrivalSeqSettled } from "../ingest/arrival-seq";
import {
  clickhouseCommand,
  clickhouseQuery,
  toIsoTimestamp,
} from "../shared/clickhouse";
import { kindFilter } from "./kind-filter";
import { emitQuerySql, QueryCompileError, compileQuery, requireCompiled } from "../query/compile";
import { mapRow, markSelect, type MarkRow } from "../query/marks";
import { queryRulesOutService } from "../alerts/first-seen";
import type { ChangeMark } from "../shared/change-mark";
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
  /** Where the row first entered and its position there: this instance's own, or a pulled row's. */
  origin: { id: string; seq: number };
};

/** A change mark in the feed's range (#138): marks move with a link, by the same positions. */
export type FeedMark = ChangeMark & { seq: number };

/** Every kind a feed reads (#325). Logs and marks are `rows` and `marks`; the rest are `kinds`. */
export const feedKinds = ["logs", "marks", "spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"] as const;
export type FeedKind = (typeof feedKinds)[number];
export type OtherKind = Exclude<FeedKind, "logs" | "marks">;
export const otherKinds: readonly OtherKind[] = ["spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"];

/** One kind's page in a reply: its rows as stored (less `tenant_id`), its own hole, or why none came. */
export type KindPage = {
  rows: Array<Record<string, unknown> & { seq: number | string }>;
  gone: { from: number; to: number } | null;
  /** Set when this kind is not sent at all, and why (“the filter names level”). */
  not_sent?: string;
};

/** Parses a `kinds` list (`logs,spans`); empty or absent is every kind. Unknown names are refused. */
export function parseKinds(raw: string | null | undefined): FeedKind[] | { error: string } {
  const names = (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (names.length === 0) {
    return [...feedKinds];
  }
  const bad = names.filter((k) => !(feedKinds as readonly string[]).includes(k));
  return bad.length > 0 ? { error: `unknown kind: ${bad.join(", ")}` } : (names as FeedKind[]);
}

/** Which retention a kind follows: points and buckets follow metrics retention when it is set. */
export function kindRetention(kind: OtherKind, days: { logs: number; metrics: number }): number {
  return kind === "metrics" || kind === "metric_buckets" ? days.metrics : days.logs;
}

/**
 * A kind's hole: positions after `after` below its oldest still stored, but only when that oldest
 * row sits at its retention edge (within a day). One counter numbers every kind, so a kind whose
 * first row came late has positions below it that were never its rows, not rows retention took.
 */
export function kindGone(input: {
  after: number;
  oldest: number | null;
  oldestTs: string | null;
  horizon: string;
}): { from: number; to: number } | null {
  if (input.oldest === null || input.oldestTs === null || input.after + 1 >= input.oldest) {
    return null;
  }
  const edge = Date.parse(input.horizon) + 86_400_000;
  return Date.parse(input.oldestTs) <= edge ? { from: input.after + 1, to: input.oldest - 1 } : null;
}

export type FeedReply = {
  feed: string;
  q: string;
  /** The range read: positions after `after`, through `through`. */
  after: number;
  through: number;
  rows: FeedRow[];
  /**
   * Marks posted (or closed) in the range: every one whose `service` the feed's `q` does not
   * rule out by a plain mismatch. A mark is not a log line, so `level:error` does not apply.
   */
  marks: FeedMark[];
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
  /** The kinds other than logs and marks that were asked for, each on the same positions. */
  kinds: Partial<Record<OtherKind, KindPage>>;
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
  src_id: string;
  src_seq: string | number;
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
  /** Points and buckets follow this; absent, they follow `retentionDays`. */
  metricsRetentionDays?: number;
  /** The kinds to read; absent, every kind. */
  kinds?: readonly FeedKind[];
  now?: number;
  /** This instance's id: the origin of its own rows. */
  hereId?: string;
}): Promise<FeedReply> {
  const kinds = new Set<FeedKind>(input.kinds ?? feedKinds);
  const now = input.now ?? Date.now();
  const limit = Math.min(feedMaxLimit, Math.max(1, Math.floor(input.limit ?? feedDefaultLimit)));
  const settled = input.settled ?? arrivalSeqSettled();
  const oldest = await oldestPosition(now);
  const range = feedRange({ after: input.after, settled, oldest });
  const logsDays = input.retentionDays ?? 30;
  const days = { logs: logsDays, metrics: input.metricsRetentionDays ?? logsDays };
  const horizon = new Date(now - logsDays * 86_400_000).toISOString();
  const empty = (): FeedReply["kinds"] =>
    Object.fromEntries(otherKinds.filter((k) => kinds.has(k)).map((k) => [k, { rows: [], gone: null }]));
  const base: Omit<FeedReply, "through" | "rows" | "marks" | "arrived" | "kinds"> = {
    feed: input.id,
    q: input.q,
    after: input.after,
    settled,
    oldest,
    horizon,
    gone: kinds.has("logs") ? range.gone : null,
  };
  if (range.through <= input.after) {
    return { ...base, through: input.after, rows: [], marks: [], arrived: null, kinds: empty() };
  }
  const params: Record<string, string> = {
    tenant_id: "default",
    after: String(input.after),
    through: String(range.through),
    limit: String(limit),
  };
  let rows: FeedSqlRow[] = [];
  if (kinds.has("logs")) {
    const where = [
      "tenant_id = {tenant_id:String}",
      "seq > {after:UInt64}",
      "seq <= {through:UInt64}",
    ];
    const qsql = emitQuerySql(requireCompiled(input.q), params, "logs");
    if (qsql) {
      where.push(qsql);
    }
    try {
      rows = await clickhouseQuery<FeedSqlRow>(
        `
        SELECT seq, ts, service, host, level, message, attrs, toposcope, src_id, src_seq
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
        return { ...base, through: input.after, rows: [], marks: [], arrived: null, kinds: empty(), refused: logsScanBudgetRefuseReason };
      }
      throw err;
    }
  }
  let out = rows.map((row) => ({
    seq: Number(row.seq),
    ts: toIsoTimestamp(String(row.ts)),
    service: row.service,
    host: row.host,
    level: row.level,
    message: row.message,
    attrs: parseAttrs(row.attrs),
    toposcope: row.toposcope,
    origin: row.src_id
      ? { id: row.src_id, seq: Number(row.src_seq) }
      : { id: input.hereId ?? "", seq: Number(row.seq) },
  }));
  // Every other kind on the same positions (#325), each page at most `limit` rows.
  const pages: FeedReply["kinds"] = {};
  for (const kind of otherKinds) {
    if (!kinds.has(kind)) {
      continue;
    }
    const kparams: Record<string, string> = { ...params };
    const filter = kindFilter(input.q, kind, kparams);
    if ("not_sent" in filter) {
      pages[kind] = { rows: [], gone: null, not_sent: filter.not_sent };
      continue;
    }
    const where = ["tenant_id = {tenant_id:String}", "seq > {after:UInt64}", "seq <= {through:UInt64}"];
    if (filter.sql) {
      where.push(filter.sql);
    }
    const krows = await clickhouseQuery<Record<string, unknown> & { seq: string | number }>(
      `SELECT * EXCEPT (tenant_id) FROM ${kind} WHERE ${where.join(" AND ")} ORDER BY seq LIMIT {limit:UInt32}`,
      kparams,
    );
    const first = await clickhouseQuery<{ n: string | number; t: string | null; c: string | number }>(
      `SELECT min(seq) AS n, argMin(${kind === "monitor_results" ? "at" : "ts"}, seq) AS t, count() AS c FROM ${kind} WHERE seq > 0`,
    );
    const kOldest = Number(first[0]?.c ?? 0) > 0 ? Number(first[0]!.n) : null;
    const kHorizon = new Date(now - kindRetention(kind, days) * 86_400_000).toISOString();
    pages[kind] = {
      rows: krows,
      gone: kindGone({ after: input.after, oldest: kOldest, oldestTs: first[0]?.t ? toIsoTimestamp(String(first[0].t)) : null, horizon: kHorizon }),
    };
  }
  // One page across every kind: it ends where the first full kind ends, or at the `limit`-th row
  // in arrival order, so no kind can skip a row another kind's page ran past.
  let through = range.through;
  if (out.length === limit) {
    through = Math.min(through, out[out.length - 1]!.seq);
  }
  for (const page of Object.values(pages)) {
    if (page.rows.length === limit) {
      through = Math.min(through, Number(page.rows[page.rows.length - 1]!.seq));
    }
  }
  const merged = [...out.map((r) => r.seq), ...Object.values(pages).flatMap((p) => p.rows.map((r) => Number(r.seq)))]
    .filter((n) => n <= through)
    .sort((a, b) => a - b);
  if (merged.length > limit) {
    through = merged[limit - 1]!;
  }
  out = out.filter((r) => r.seq <= through);
  for (const page of Object.values(pages)) {
    page.rows = page.rows.filter((r) => Number(r.seq) <= through);
  }
  const read = [...(kinds.has("logs") ? ["logs"] : []), ...Object.keys(pages).filter((k) => !pages[k as OtherKind]!.not_sent)];
  const arrivedRows =
    read.length === 0
      ? []
      : await clickhouseQuery<{ a: string; c: string | number }>(
          `SELECT max(a) AS a, sum(c) AS c FROM (${read
            .map(
              (t) =>
                `SELECT max(arrived) AS a, count() AS c FROM ${t} WHERE tenant_id = {tenant_id:String} AND seq > {after:UInt64} AND seq <= {through:UInt64}`,
            )
            .join(" UNION ALL ")})`,
          { tenant_id: "default", after: String(input.after), through: String(through) },
        );
  const arrived =
    Number(arrivedRows[0]?.c ?? 0) > 0 ? toIsoTimestamp(String(arrivedRows[0]!.a)) : null;
  let marks: FeedMark[] = [];
  if (kinds.has("marks")) {
    const ast = requireCompiled(input.q).ast;
    const markRows = await clickhouseQuery<MarkRow & { seq: string | number }>(
      `SELECT ${markSelect}, seq FROM change_marks
       WHERE tenant_id = 'default' AND seq > {after:UInt64} AND seq <= {through:UInt64}
       ORDER BY seq`,
      { after: String(input.after), through: String(through) },
    );
    marks = markRows
      .map((row) => ({ ...mapRow(row), seq: Number(row.seq) }))
      .filter((mark) => !queryRulesOutService(ast, mark.service));
  }
  return { ...base, through, rows: out, marks, arrived, kinds: pages };
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

/** The kinds whose sort order scatters positions that arrived together. */
export const fullSeqProjectionTables = ["spans", "metrics", "metric_buckets", "profile_samples", "monitor_results"] as const;
export type FullSeqProjectionTable = (typeof fullSeqProjectionTables)[number];

/**
 * A full copy ordered by `seq` (#324): spans are sorted by `trace_id`, metrics and buckets by
 * `name`, profiles by `trace_id`, so a `seq, _part_offset` projection finds a range but still reads
 * every granule (measured: 11M spans for a 5,000-row page; 17k with this). Built only once a link
 * carries the kind, so an instance with no such link pays no disk.
 */
export async function ensureFullSeqProjection(table: FullSeqProjectionTable): Promise<void> {
  const rows = await clickhouseQuery<{ name: string }>(
    `SELECT name FROM system.projections WHERE database = currentDatabase() AND table = {table:String} AND name = 'by_seq_full'`,
    { table },
  ).catch(() => [] as { name: string }[]);
  if (rows.length > 0) {
    return;
  }
  await clickhouseCommand(`ALTER TABLE ${table} ADD PROJECTION IF NOT EXISTS by_seq_full (SELECT * ORDER BY seq)`);
  await clickhouseCommand(`ALTER TABLE ${table} MATERIALIZE PROJECTION by_seq_full`);
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
  const kinds = parseKinds(c.req.query("kinds"));
  if ("error" in kinds) {
    return c.json({ error: kinds.error }, 400);
  }
  try {
    return c.json(
      await readFeed({
        id: feed.id,
        q: feed.q,
        after,
        limit,
        kinds,
        retentionDays: getRetentionDays(),
        metricsRetentionDays: effectiveMetricsRetentionDays(),
        hereId: instanceId(),
      }),
    );
  } catch (err) {
    if (err instanceof QueryCompileError) {
      return c.json({ error: err.message, faults: err.faults }, 400);
    }
    throw err;
  }
}
