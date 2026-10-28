import { pulledMonitors } from "../links/monitors-snapshot";
import { actorName } from "./actors";
import type { Context } from "hono";
import { lastLineAt } from "../alerts/last-line";
import { lastPushResult, resultsBetween } from "../alerts/monitor-results";
import {
  monitorHistory,
  openStretch,
  sentCallsBetween,
  stretchesBetween,
  type PushResultRow,
  type StretchWithCalls,
} from "../alerts/monitor-store";
import { parseRangeMs } from "../query/relative";
import { publicUrl } from "../shared/public-url";
import {
  allAlertRules,
  applyMonitorFields,
  applyMonitorHold,
  getAlert,
  insertMonitor,
  readJsonObject,
  readMonitorFields,
  removeMonitor,
  updateAlertRule,
  type AlertRule,
} from "./alerts";
import { getHttp } from "../alerts/http-store";
import { getNet } from "../alerts/net-store";
import { isNetSource, type NetSource } from "../shared/net-check";
import { applyHttpFields, existingHttp, httpView, insertHttpMonitor, readHttpFields, type HttpView } from "./http-monitors";
import { applyNetFields, existingNet, insertNetMonitor, netView, readNetFields, type NetView } from "./net-monitors";
import {
  applyPushFields,
  insertPushMonitor,
  pingKeyOf,
  pushCapProblem,
  readPushFields,
} from "./push-monitors";
import { getDb } from "./index";
import { placeOf } from "./monitor-place";
import { getSaved } from "./saved-searches";

/** Watch's clock: 24h, 7d or 30d, or a hunt's own from/to. */
const watchRanges = new Set(["24h", "7d", "30d"]);
const maxWindowMs = 366 * 24 * 60 * 60_000;

export type MonitorView = AlertRule & {
  made_by?: import("./actors").ActorName | null;
  /** The saved search it reads, as Watch names it. */
  saved: { id: string; name: string; query: string; range: string | null; agg: string | null } | null;
  /** Its open stretch, with the calls sent for it so far. */
  open: StretchWithCalls | null;
  /**
   * A fewer-than monitor's newest matching line (#176): null when none in a year, left out when
   * it could not be read.
   */
  last_line_at?: number | null;
  /** What an HTTP(S) monitor calls (#178): its headers by name only. */
  http: HttpView | null;
  /** Where a TCP or certificate monitor connects (#180). */
  net: NetView | null;
};

async function view(rule: AlertRule): Promise<MonitorView> {
  const saved = rule.saved_search_id ? getSaved(rule.saved_search_id) : null;
  const open = rule.state === "open" ? openStretch(rule.id) : null;
  // One row a monitor, read with Watch's refresh; only a monitor on a quiet stream says it.
  const lastLine =
    saved && rule.kind === "threshold" && rule.opens_when === "fewer_than" ? await lastLineAt(saved.query) : undefined;
  const http = rule.source === "http" ? getHttp(rule.id) : null;
  const net = isNetSource(rule.source) ? getNet(rule.id) : null;
  return {
    ...rule,
    http: http ? httpView(http) : null,
    net: net ? netView(net) : null,
    saved: saved
      ? { id: saved.id, name: saved.name, query: saved.query, range: saved.range, agg: saved.agg }
      : null,
    open: open ? { ...open, calls: monitorHistory(rule.id, 1)[0]?.calls ?? [] } : null,
    ...(lastLine !== undefined ? { last_line_at: lastLine } : {}),
    // #307: who made it, for Watch's row and a Viewer's "ask an Operator".
    made_by: actorName(rule.created_by),
  };
}

function windowOf(c: Context, now: number): { fromMs: number; toMs: number } | { error: string } {
  const range = c.req.query("range");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from || to) {
    const fromMs = Date.parse(from ?? "");
    const toMs = Date.parse(to ?? "");
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > maxWindowMs) {
      return { error: "from and to must be ISO times, from before to, at most 366d apart" };
    }
    return { fromMs, toMs };
  }
  const id = range ?? "24h";
  if (!watchRanges.has(id)) {
    return { error: "range must be 24h, 7d or 30d" };
  }
  return { fromMs: now - parseRangeMs(id)!, toMs: now };
}

/**
 * `GET /api/monitors` — every monitor with its state, the stretches open at any time in the
 * window (24h by default; `range=7d|30d`, or a hunt's `from`/`to`), each with its calls, the
 * new-fingerprints calls sent in it, and the results in it for the lanes' ticks, in 240 columns a
 * monitor, the worst of each.
 */
export async function listMonitors(c: Context): Promise<Response> {
  const now = Date.now();
  const win = windowOf(c, now);
  if ("error" in win) {
    return c.json({ error: win.error }, 400);
  }
  return c.json({
    now,
    from: new Date(win.fromMs).toISOString(),
    to: new Date(win.toMs).toISOString(),
    monitors: await Promise.all(allAlertRules().map(view)),
    stretches: stretchesBetween(win.fromMs, win.toMs),
    sent: sentCallsBetween(win.fromMs, win.toMs),
    // Results on the clock (#177, #178): each a tick, at most 240 columns a lane.
    results: await resultsBetween(win.fromMs, win.toMs),
    // Each linked source's monitors (#333), read-only: their results are in `results` by id.
    sources: pulledMonitors().map((p) => ({
      source: p.source,
      at: p.at,
      monitors: p.monitors,
      stretches: p.stretches.filter((s) => s.opened_at <= win.toMs && (s.resolved_at === null || s.resolved_at >= win.fromMs)),
    })),
    link: publicUrl() !== null,
  });
}

/**
 * A monitor's own page: the monitor, and for a push monitor its keyed URL's key and its last
 * result. The key is printed here and nowhere else (#177).
 */
async function page(rule: AlertRule): Promise<MonitorView & { ping_key?: string | null; last?: PushResultRow | null }> {
  if (rule.source !== "push") {
    return view(rule);
  }
  return { ...(await view(rule)), ping_key: pingKeyOf(rule.id), last: await lastPushResult(rule.id) };
}

function byName(name: string): AlertRule[] {
  const ids = getDb().query("SELECT id FROM alert_rules WHERE name = ? ORDER BY created_at").all(name) as Array<{
    id: string;
  }>;
  return ids.map((row) => getAlert(row.id)).filter((rule): rule is AlertRule => rule !== null);
}

function oneByName(c: Context): AlertRule | Response | null {
  const name = (c.req.param("name") ?? "").trim();
  if (!name) {
    return c.json({ error: "name required" }, 400);
  }
  const found = byName(name);
  if (found.length > 1) {
    return c.json({ error: `${found.length} monitors are named ${name}; rename one in Watch` }, 409);
  }
  return found[0] ?? null;
}

/** `GET /api/monitors/:name` — one monitor and its last 200 stretches, newest first, with their calls. */
export async function getMonitor(c: Context): Promise<Response> {
  const rule = oneByName(c);
  if (rule instanceof Response) {
    return rule;
  }
  if (!rule) {
    return c.json({ error: "Monitor not found" }, 404);
  }
  return c.json({ ...(await page(rule)), stretches: monitorHistory(rule.id) });
}

/** "a push", "an HTTP(S)", "a TCP", "a certificate", "a search": a source as a sentence names it. */
function aSource(source: unknown): string {
  return source === "http" ? "an HTTP(S)" : source === "tcp" ? "a TCP" : source === "cert" ? "a certificate" : `a ${String(source)}`;
}

/**
 * A source a monitor keeps: a push, HTTP(S), TCP or certificate monitor stays one, and nothing
 * else becomes one.
 */
function sourceChange(existing: AlertRule | null, rec: Record<string, unknown>): string | null {
  const keeps = (source: unknown) => source === "push" || source === "http" || isNetSource(source);
  if (!existing || rec.source === undefined || rec.source === existing.source) {
    return null;
  }
  if (keeps(existing.source) || keeps(rec.source)) {
    return `${existing.name} is ${aSource(existing.source)} monitor; delete it to make ${aSource(rec.source)} monitor of that name`;
  }
  return null;
}

/** `PUT /api/monitors/<name>` with `source: "push"`: create or replace a push monitor (#177). */
async function putPushMonitor(
  c: Context,
  name: string,
  existing: AlertRule | null,
  rec: Record<string, unknown>,
): Promise<Response> {
  const fields = readPushFields({ ...rec, name }, null);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  if (!existing) {
    const cap = pushCapProblem(1);
    if (cap) {
      return c.json({ error: cap }, 400);
    }
    const place = placeOf(c);
    if (place instanceof Response) {
      return place;
    }
    const created = insertPushMonitor(fields, place, now);
    if ("error" in created) {
      return c.json({ error: created.error }, 400);
    }
    applyMonitorHold(created, rec, now);
    return c.json(await page(getAlert(created.id)!), 201);
  }
  const problem = applyPushFields(existing, fields, now);
  if (problem) {
    return c.json({ error: problem.error }, 400);
  }
  applyMonitorHold(getAlert(existing.id)!, rec, now);
  return c.json(await page(getAlert(existing.id)!));
}

/**
 * `PUT /api/monitors/<name>` with `source: "http"`: create or replace an HTTP(S) monitor (#178).
 * What is left out takes its default, and a header given as null keeps its stored value.
 */
async function putHttpMonitor(
  c: Context,
  name: string,
  existing: AlertRule | null,
  rec: Record<string, unknown>,
): Promise<Response> {
  const kept = existing ? existingHttp(existing) : null;
  const fields = readHttpFields({ ...rec, name }, null, kept?.http.headers ?? []);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  if (!kept) {
    const place = placeOf(c);
    if (place instanceof Response) {
      return place;
    }
    const created = insertHttpMonitor(fields, place, now);
    applyMonitorHold(created, rec, now);
    return c.json(await page(getAlert(created.id)!), 201);
  }
  applyHttpFields(kept.rule, kept.http, fields, now);
  applyMonitorHold(getAlert(kept.rule.id)!, rec, now);
  return c.json(await page(getAlert(kept.rule.id)!));
}

/**
 * `PUT /api/monitors/<name>` with `source: "tcp" | "cert"`: create or replace a TCP or
 * certificate monitor (#180). What is left out takes its default.
 */
async function putNetMonitor(
  c: Context,
  name: string,
  source: NetSource,
  existing: AlertRule | null,
  rec: Record<string, unknown>,
): Promise<Response> {
  const kept = existing ? existingNet(existing) : null;
  const fields = readNetFields({ ...rec, name }, source, null);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  if (!kept) {
    const place = placeOf(c);
    if (place instanceof Response) {
      return place;
    }
    const created = insertNetMonitor(fields, place, now);
    applyMonitorHold(created, rec, now);
    return c.json(await page(getAlert(created.id)!), 201);
  }
  applyNetFields(kept.rule, kept.net, fields, now);
  applyMonitorHold(getAlert(kept.rule.id)!, rec, now);
  return c.json(await page(getAlert(kept.rule.id)!));
}

/**
 * `PUT /api/alert-rules/<id>`: what it did, and for a push monitor its own fields, a field left
 * out keeping its value.
 */
export async function updateMonitorRoute(c: Context): Promise<Response> {
  const existing = getAlert(c.req.param("id") ?? "");
  if (!existing || existing.source !== "push") {
    return updateAlertRule(c);
  }
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const change = sourceChange(existing, rec);
  if (change) {
    return c.json({ error: change }, 400);
  }
  const fields = readPushFields(rec, existing);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  const problem = applyPushFields(existing, fields, now);
  if (problem) {
    return c.json({ error: problem.error }, 400);
  }
  applyMonitorHold(getAlert(existing.id)!, rec, now);
  return c.json(getAlert(existing.id));
}

/**
 * `PUT /api/monitors/:name` — create or replace the monitor of that name, so a script or an
 * agent can declare monitors without the UI. A replace keeps its record, its silence and whether
 * it is paused; what is left out of the body takes its default. 201 when created, 200 when replaced.
 */
export async function putMonitor(c: Context): Promise<Response> {
  const name = (c.req.param("name") ?? "").trim();
  const existing = oneByName(c);
  if (existing instanceof Response) {
    return existing;
  }
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const keeps = existing?.source === "push" || existing?.source === "http" || isNetSource(existing?.source);
  if (rec.source === undefined && rec.kind === undefined && !keeps) {
    return c.json({ error: "source is required: search, fingerprints, push, http, tcp or cert" }, 400);
  }
  const change = sourceChange(existing, rec);
  if (change) {
    return c.json({ error: change }, 400);
  }
  if (rec.source === "push" || existing?.source === "push") {
    return putPushMonitor(c, name, existing, rec);
  }
  if (rec.source === "http" || existing?.source === "http") {
    return putHttpMonitor(c, name, existing, rec);
  }
  const net = isNetSource(rec.source) ? rec.source : isNetSource(existing?.source) ? existing.source : null;
  if (net) {
    return putNetMonitor(c, name, net, existing, rec);
  }
  const fields = readMonitorFields({ ...rec, name }, null);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  const now = Date.now();
  if (!existing) {
    const place = placeOf(c);
    if (place instanceof Response) {
      return place;
    }
    const created = insertMonitor(fields, place, now);
    applyMonitorHold(created, rec, now);
    return c.json(await view(getAlert(created.id)!), 201);
  }
  applyMonitorFields(existing, fields, now);
  applyMonitorHold(getAlert(existing.id)!, rec, now);
  return c.json(await view(getAlert(existing.id)!));
}

/** `DELETE /api/monitors/:name` — the monitor and its record. */
export async function deleteMonitor(c: Context): Promise<Response> {
  const rule = oneByName(c);
  if (rule instanceof Response) {
    return rule;
  }
  if (!rule) {
    return c.json({ error: "Monitor not found" }, 404);
  }
  removeMonitor(rule.id);
  return c.json({ ok: true });
}
