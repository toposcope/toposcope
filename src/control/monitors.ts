import type { Context } from "hono";
import {
  monitorHistory,
  openStretch,
  sentCallsBetween,
  stretchesBetween,
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
  type AlertRule,
} from "./alerts";
import { getHttp } from "../alerts/http-store";
import { applyHttpFields, existingHttp, httpView, insertHttpMonitor, readHttpFields, type HttpView } from "./http-monitors";
import { getDb } from "./index";
import { getSaved } from "./saved-searches";

/** Watch's clock: 24h, 7d or 30d, or a hunt's own from/to. */
const watchRanges = new Set(["24h", "7d", "30d"]);
const maxWindowMs = 366 * 24 * 60 * 60_000;

export type MonitorView = AlertRule & {
  /** The saved search it reads, as Watch names it. */
  saved: { id: string; name: string; query: string; range: string | null; agg: string | null } | null;
  /** Its open stretch, with the calls sent for it so far. */
  open: StretchWithCalls | null;
  /** What an HTTP(S) monitor calls (#178): its headers by name only. */
  http: HttpView | null;
};

function view(rule: AlertRule): MonitorView {
  const saved = rule.saved_search_id ? getSaved(rule.saved_search_id) : null;
  const open = rule.state === "open" ? openStretch(rule.id) : null;
  const http = rule.source === "http" ? getHttp(rule.id) : null;
  return {
    ...rule,
    http: http ? httpView(http) : null,
    saved: saved
      ? { id: saved.id, name: saved.name, query: saved.query, range: saved.range, agg: saved.agg }
      : null,
    open: open ? { ...open, calls: monitorHistory(rule.id, 1)[0]?.calls ?? [] } : null,
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
 * window (24h by default; `range=7d|30d`, or a hunt's `from`/`to`), each with its calls, and the
 * new-fingerprints calls sent in it.
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
    monitors: allAlertRules().map(view),
    stretches: stretchesBetween(win.fromMs, win.toMs),
    sent: sentCallsBetween(win.fromMs, win.toMs),
    link: publicUrl() !== null,
  });
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
  return c.json({ ...view(rule), stretches: monitorHistory(rule.id) });
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
  if (rec.source === undefined && rec.kind === undefined) {
    return c.json({ error: "source is required: search, fingerprints or http" }, 400);
  }
  const now = Date.now();
  if (rec.source === "http") {
    const kept = existing ? existingHttp(existing) : null;
    if (existing && !kept) {
      return c.json({ error: `${name} is a ${existing.source} monitor; delete it to make it an HTTP(S) one` }, 409);
    }
    // A replace: what is left out takes its default, and a header given as null keeps its stored value.
    const fields = readHttpFields({ ...rec, name }, null, kept?.http.headers ?? []);
    if ("error" in fields) {
      return c.json({ error: fields.error }, fields.status);
    }
    if (!kept) {
      const created = insertHttpMonitor(fields, now);
      applyMonitorHold(created, rec, now);
      return c.json(view(getAlert(created.id)!), 201);
    }
    applyHttpFields(kept.rule, kept.http, fields, now);
    applyMonitorHold(getAlert(kept.rule.id)!, rec, now);
    return c.json(view(getAlert(kept.rule.id)!));
  }
  if (existing?.source === "http") {
    return c.json({ error: `${name} is an http monitor; delete it to make it a ${String(rec.source ?? "search")} one` }, 409);
  }
  const fields = readMonitorFields({ ...rec, name }, null);
  if ("error" in fields) {
    return c.json({ error: fields.error }, fields.status);
  }
  if (!existing) {
    const created = insertMonitor(fields, now);
    applyMonitorHold(created, rec, now);
    return c.json(view(getAlert(created.id)!), 201);
  }
  applyMonitorFields(existing, fields, now);
  applyMonitorHold(getAlert(existing.id)!, rec, now);
  return c.json(view(getAlert(existing.id)!));
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
