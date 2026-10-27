import type { Context } from "hono";
import type { ChangeMark } from "../shared/change-mark";
import { clickhouseQuery } from "../shared/clickhouse";
import { evaluateAlertSeries } from "../alerts/series";
import { search } from "../query";
import { seriesLabel } from "../query/agg";
import { searchFingerprintCut } from "../query/fingerprint-cut";
import { changeMarksBetween, getChangeMarkById } from "../query/marks";
import { allSaved, visibleSaved } from "./saved-searches";
import { actorOf } from "../actor-context";
import type { Actor } from "./people";

/**
 * Home: what changed since a mark (#259, frames 26a–26c). Locked 2026-10-26:
 * - the selected mark is the newest deploy or flag in 24 h, else the newest mark of any kind in
 *   24 h, else the last hour against the hour before; an incident is shown but never auto-selected;
 * - equal windows: after = min(age, gap to the next mark of any kind, 60 min), floored at 5 min,
 *   and before is the same span ending at the mark.
 */
export const dayMs = 24 * 60 * 60_000;
export const hourMs = 60 * 60_000;
export const maxSideMs = 60 * 60_000;
export const minSideMs = 5 * 60_000;

export type Window = { from: string; to: string };

/** The mark Home selects on its own, or null for the quiet reading. `marks` is newest first. */
export function pickHomeMark(marks: ChangeMark[], nowMs: number): ChangeMark | null {
  const recent = marks.filter((m) => nowMs - Date.parse(m.ts) <= dayMs && Date.parse(m.ts) <= nowMs);
  return recent.find((m) => m.kind === "deploy" || m.kind === "flag") ?? recent[0] ?? null;
}

/** Equal windows around a mark: the side is the gap to the next mark of any kind, capped and floored. */
export function windowsAround(mark: ChangeMark, marks: ChangeMark[], nowMs: number): { before: Window; after: Window; sideMs: number } {
  const t = Date.parse(mark.ts);
  const later = marks.map((m) => Date.parse(m.ts)).filter((ts) => ts > t);
  const next = later.length ? Math.min(...later) : Number.POSITIVE_INFINITY;
  const sideMs = Math.max(minSideMs, Math.min(maxSideMs, nowMs - t, next - t));
  return {
    before: { from: new Date(t - sideMs).toISOString(), to: new Date(t).toISOString() },
    after: { from: new Date(t).toISOString(), to: new Date(t + sideMs).toISOString() },
    sideMs,
  };
}

/** The quiet reading (26b): the last hour against the hour before. */
export function hourWindows(nowMs: number): { before: Window; after: Window; sideMs: number } {
  return {
    before: { from: new Date(nowMs - 2 * hourMs).toISOString(), to: new Date(nowMs - hourMs).toISOString() },
    after: { from: new Date(nowMs - hourMs).toISOString(), to: new Date(nowMs).toISOString() },
    sideMs: hourMs,
  };
}

export type HomeCard = {
  saved_id: string;
  name: string;
  /** "count", "rate", "p99 duration_ms", as the hunt names the series. */
  kind: string;
  before: number | null;
  after: number | null;
  refused: string | null;
  /** Volume per bucket over before + after, oldest first; the mark sits between the halves. */
  spark: number[];
  /** Index of the first bucket at or after the mark. */
  split_at: number;
  /** Who saved the hunt (#307, 30e): "saved by Maya K.", or yours. */
  saved_by: { id: string; name: string } | null;
  /** On everyone's Home (#306), or only its owner's. */
  shared: boolean;
};

export type HomeFingerprint = { hex: string; message: string; service: string; count: number };

export type HomeSince = {
  now: string;
  since: { kind: "mark"; mark: ChangeMark; auto: boolean } | { kind: "hour" };
  before: Window;
  after: Window;
  side_ms: number;
  marks: ChangeMark[];
  cards: HomeCard[];
  fingerprints: { first_seen: HomeFingerprint[]; stopped: HomeFingerprint[]; more: number } | null;
  ingested: boolean;
};

type CacheEntry = { at: number; value: HomeSince };
const cache = new Map<string, CacheEntry>();
const cacheMs = 30_000;

async function cardFor(saved: ReturnType<typeof allSaved>[number], before: Window, after: Window): Promise<HomeCard> {
  const read = (w: Window) => evaluateAlertSeries({ query: saved.query, range: null, from_ts: w.from, to_ts: w.to, agg: saved.agg ?? null });
  const [b, a, spark] = await Promise.all([
    read(before),
    read(after),
    search({ q: saved.query, from: before.from, to: after.to, events: "0", split: "none" }).catch(() => null),
  ]);
  const buckets = spark?.histogram ?? [];
  const markMs = Date.parse(after.from);
  const splitAt = Math.max(0, buckets.findIndex((bk) => Date.parse(bk.t) >= markMs));
  const refused = b.refused ? (b.reason ?? "refused") : a.refused ? (a.reason ?? "refused") : null;
  return {
    saved_id: saved.id,
    name: saved.name,
    saved_by: saved.saved_by ? { id: saved.saved_by.id, name: saved.saved_by.name } : null,
    shared: saved.shared,
    kind: seriesLabel(saved.agg ?? null).toLowerCase(),
    before: b.refused ? null : b.value,
    after: a.refused ? null : a.value,
    refused,
    spark: buckets.map((bk) => bk.n),
    split_at: buckets.length ? splitAt : 0,
  };
}

async function anyIngested(): Promise<boolean> {
  const rows = await clickhouseQuery<{ one: number }>("SELECT 1 AS one FROM logs LIMIT 1").catch(() => []);
  return rows.length > 0;
}

export async function computeHomeSince(input: { markId: string | null; hour: boolean; nowMs?: number; actor?: Actor | null }): Promise<HomeSince | { error: string; status: 404 }> {
  const nowMs = input.nowMs ?? Date.now();
  const marks = await changeMarksBetween(new Date(nowMs - dayMs).toISOString(), new Date(nowMs + 60_000).toISOString());
  let mark: ChangeMark | null = null;
  let auto = false;
  if (input.markId) {
    mark = marks.find((m) => m.id === input.markId) ?? (await getChangeMarkById(input.markId));
    if (!mark) {
      return { error: "mark not found", status: 404 };
    }
  } else if (!input.hour) {
    mark = pickHomeMark(marks, nowMs);
    auto = true;
  }
  // #306: the hunts this person sees, shared ones and their own.
  const saved = (input.actor === undefined ? allSaved() : visibleSaved(input.actor)).filter((s) => !s.board);
  // The cache turns over every 30 s and whenever a saved hunt is added or edited.
  const key = `${input.actor?.person.id ?? "all"}:${mark?.id ?? "hour"}:${Math.floor(nowMs / cacheMs)}:${saved.map((s) => `${s.id}=${s.query}|${s.agg ?? ""}`).join(",")}`;
  const hit = cache.get(key);
  if (hit) {
    return hit.value;
  }
  const win = mark ? windowsAround(mark, marks, nowMs) : hourWindows(nowMs);
  const [cards, cut, ingested] = await Promise.all([
    Promise.all(saved.map((s) => cardFor(s, win.before, win.after))),
    mark
      ? searchFingerprintCut({ mark, from: win.before.from, to: win.after.to, now: nowMs }).catch(() => null)
      : Promise.resolve(null),
    anyIngested(),
  ]);
  const row = (r: { hex: string; message: string; service: string; after: number; before: number }, side: "after" | "before"): HomeFingerprint => ({
    hex: r.hex,
    message: r.message,
    service: r.service,
    count: side === "after" ? r.after : r.before,
  });
  const firstSeen = cut?.sets.find((s) => s.id === "first_seen");
  const stopped = cut?.sets.find((s) => s.id === "stopped");
  const value: HomeSince = {
    now: new Date(nowMs).toISOString(),
    since: mark ? { kind: "mark", mark, auto } : { kind: "hour" },
    before: win.before,
    after: win.after,
    side_ms: win.sideMs,
    marks,
    cards,
    fingerprints: cut
      ? {
          first_seen: (firstSeen?.rows ?? []).map((r) => row(r, "after")),
          stopped: (stopped?.rows ?? []).map((r) => row(r, "before")),
          more: (firstSeen?.more ?? 0) + (stopped?.more ?? 0),
        }
      : null,
    ingested,
  };
  cache.set(key, { at: nowMs, value });
  for (const [k, v] of cache) {
    if (nowMs - v.at > cacheMs * 2) {
      cache.delete(k);
    }
  }
  return value;
}

/** `GET /api/home/since?mark=<id>` or `?since=hour`. */
export async function homeSinceRoute(c: Context): Promise<Response> {
  const markId = c.req.query("mark")?.trim() || null;
  const hour = c.req.query("since") === "hour";
  const out = await computeHomeSince({ markId, hour, actor: actorOf(c) });
  if ("error" in out) {
    return c.json({ error: out.error }, out.status);
  }
  return c.json(out);
}
