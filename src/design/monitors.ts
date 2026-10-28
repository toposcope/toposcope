import type { Context, Handler } from "hono";
import type { MonitorPlace } from "../control/monitor-place";
import { actorOf } from "../actor-context";
import { monitorPreview, previewWindows, type PreviewPoint, type PreviewWindow } from "../alerts/preview";
import { getHttp } from "../alerts/http-store";
import { getNet } from "../alerts/net-store";
import { getAlert, monitorsNamed, readMonitorFields, type AlertRule, type MonitorFields } from "../control/alerts";
import { existingHttp, readHttpFields } from "../control/http-monitors";
import { readPlace } from "../control/monitor-place";
import { sourceChange } from "../control/monitors";
import { existingNet, readNetFields } from "../control/net-monitors";
import { readPushFields } from "../control/push-monitors";
import { getSaved } from "../control/saved-searches";
import { formatHttpEvery } from "../shared/http-check";
import { isNetSource, type NetSource } from "../shared/net-check";
import { formatSpan } from "../shared/push";
import { noteUndo, notePreview, previewFirst, previewMs, type Target } from "./preview-gate";
import { answerWith, readObject, type Undo } from "./answer";

/** A draft's preview reads the last 7 days (#360); Watch this reads one. */
export const draftPreviewDays = 7;
const dayMs = 24 * 60 * 60_000;
/** The stretches a preview lists at most; the count is all of them. */
const mostStretches = 50;

/** Where a monitor is in the app: Watch lists every monitor, by name. */
export const watchLink = "/?view=watch";

type Source = "search" | "fingerprints" | "push" | "http" | "tcp" | "cert";

function sourceOfRule(rule: AlertRule): Source {
  if (rule.source === "push" || rule.source === "http" || isNetSource(rule.source)) {
    return rule.source as Source;
  }
  return rule.kind === "first_seen" ? "fingerprints" : "search";
}

/**
 * The body `PUT /api/monitors/:name` takes to make this monitor again as it is now: every field
 * it reads, so what a replace leaves out at its default is not left out. An HTTP(S) monitor's
 * header values are never shown, so each header is given as null, which keeps the stored value.
 */
export function monitorBodyOf(rule: AlertRule): Record<string, unknown> {
  const source = sourceOfRule(rule);
  const body: Record<string, unknown> = {
    source,
    service: rule.service ?? "",
    host: rule.host ?? "",
    body_kind: rule.body_kind,
    body_template: rule.body_template,
    resolved_body: rule.resolved_body,
    remind_every: rule.remind_every,
  };
  if (source === "search" || source === "fingerprints") {
    body.saved_search_id = rule.saved_search_id;
    body.threshold = rule.threshold;
    if (source === "search") {
      body.opens_when = rule.opens_when;
      body.measure = rule.measure;
    }
    if (rule.webhook_urls) {
      body.webhook_urls = rule.webhook_urls;
    } else {
      body.webhook_url = rule.webhook_url;
    }
    return body;
  }
  body.webhook_url = rule.webhook_url || null;
  if (source === "push") {
    body.every = rule.every_ms === null ? null : formatSpan(rule.every_ms);
    body.grace = rule.grace_ms === null ? null : formatSpan(rule.grace_ms);
    return body;
  }
  if (source === "http") {
    const http = getHttp(rule.id);
    if (http) {
      Object.assign(body, {
        url: http.url,
        method: http.method,
        body: http.body,
        headers: http.headers.map(([name]) => [name, null]),
        conditions: http.conditions,
        every: formatHttpEvery(http.every_ms),
        fail_after: http.fail_after,
      });
    }
    return body;
  }
  const net = getNet(rule.id);
  if (net) {
    Object.assign(body, {
      target: net.target,
      ...(source === "cert" ? { starttls: net.starttls } : {}),
      conditions: net.conditions,
      every: formatHttpEvery(net.every_ms),
      fail_after: net.fail_after,
    });
  }
  return body;
}

function oneNamed(name: string): AlertRule | null {
  const found = monitorsNamed([name]);
  return found.length === 1 ? found[0]! : null;
}

/**
 * `PUT /api/monitors/:name` with its answer's link and undo: a new monitor is undone by deleting
 * it, a changed one by putting back the body it had, which is let through without a preview.
 */
export function monitorPutWithUndo(handler: Handler): Handler {
  return async (c, next) => {
    const name = (c.req.param("name") ?? "").trim();
    const before = name ? oneNamed(name) : null;
    const previous = before ? monitorBodyOf(before) : null;
    const res = await handler(c, next);
    if (!(res instanceof Response)) {
      return res;
    }
    return answerWith(res, () => {
      const undo: Undo = previous
        ? { tool: "monitor_put", arguments: { name, body: previous }, does: `Puts ${name} back as it was before this change` }
        : { tool: "monitor_delete", arguments: { name }, does: `Deletes ${name}, which this made` };
      const actor = actorOf(c);
      if (previous && actor) {
        noteUndo(actor.person.id, previous, { name });
      }
      return { link: watchLink, undo };
    });
  };
}

/** The series by the hour: the worst bar of each, as the monitor would read it. */
function hourly(series: PreviewPoint[], fewer: boolean): PreviewPoint[] {
  const by = new Map<number, number>();
  for (const p of series) {
    const hour = Math.floor(Date.parse(p.t) / 3_600_000) * 3_600_000;
    const was = by.get(hour);
    by.set(hour, was === undefined ? p.v : fewer ? Math.min(was, p.v) : Math.max(was, p.v));
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t: new Date(t).toISOString(), v: Math.round(v * 1000) / 1000 }));
}

/** Why a source has no past to read back, and what to call instead. */
const cannotPreview: Record<Exclude<Source, "search">, string> = {
  fingerprints: "A new-fingerprints monitor opens on a fingerprint first seen after it is made, so there is no past to read it against; search_cut shows what is new since a mark",
  push: "A push monitor opens when a result is late, so there is nothing to read back before something sends to it",
  http: "An HTTP(S) monitor has no results before it runs: monitor_send runs its check once from here",
  tcp: "A TCP monitor has no results before it runs: monitor_send runs its connect once from here",
  cert: "A certificate monitor has no results before it runs: monitor_send reads the certificate once from here",
};

/** A preview reads as a replace does, but a body with no source reads as a search, as a make by POST does. */
type Mode = "put" | "create" | "update" | "preview";
type Draft =
  | { ok: true; source: Source; name: string; existing: AlertRule | null; place: MonitorPlace; fields: { status?: never } & object }
  | { ok: false; error: string; status: 400 | 404 | 409; field?: string };

function refuse(error: string, status: 400 | 404 | 409 = 400, field?: string): Draft {
  return { ok: false, error, status, ...(field ? { field } : {}) };
}

/**
 * A monitor's body read as its route would save it, without saving it: a replace by name
 * (`PUT /api/monitors/:name`, what is left out takes its default), a make (`POST
 * /api/alert-rules`), or a change by id (`PUT /api/alert-rules/:id`, what is left out keeps its
 * value). The refusal is the route's own.
 */
export function readDraft(rec: Record<string, unknown>, target: Target, mode: Mode): Draft {
  let existing: AlertRule | null = null;
  let name: string;
  if ("id" in target) {
    existing = getAlert(target.id);
    if (!existing) {
      return refuse("Alert rule not found", 404);
    }
    name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : existing.name;
  } else {
    name = target.name.trim();
    if (!name) {
      return refuse("name is required", 400, "name");
    }
    if (mode === "put" || mode === "preview") {
      const named = monitorsNamed([name]);
      if (named.length > 1) {
        return refuse(`${named.length} monitors are named ${name}; rename one in Watch`, 409);
      }
      existing = named[0] ?? null;
    }
  }
  const change = existing ? sourceChange(existing, rec) : null;
  if (change) {
    return refuse(change);
  }
  const kept: Source | null = existing && (existing.source === "push" || existing.source === "http" || isNetSource(existing.source)) ? (existing.source as Source) : null;
  if (mode === "put" && rec.source === undefined && rec.kind === undefined && !kept) {
    return refuse("source is required: search, fingerprints, push, http, tcp or cert", 400, "source");
  }
  const place = readPlace(rec, existing);
  if ("error" in place) {
    return refuse(place.error, 400, "service");
  }
  const asked = rec.source === "push" || rec.source === "http" || isNetSource(rec.source) ? (rec.source as Source) : null;
  const special = mode === "update" ? kept : (kept ?? asked);
  const withName = { ...rec, name };
  let fields: object | { error: string; status: 400 | 404 };
  let source: Source;
  if (special === "push" && mode !== "create") {
    source = "push";
    fields = readPushFields(withName, mode === "update" ? existing : null);
  } else if (special === "http") {
    source = "http";
    const http = existing ? existingHttp(existing) : null;
    fields = mode === "update" ? readHttpFields(rec, http) : readHttpFields(withName, null, http?.http.headers ?? []);
  } else if (special === "tcp" || special === "cert") {
    source = special;
    const net = existing ? existingNet(existing) : null;
    fields = mode === "update" ? readNetFields(rec, special as NetSource, net) : readNetFields(withName, special as NetSource, null);
  } else {
    if (mode === "create" && (typeof rec.saved_search_id !== "string" || rec.saved_search_id.length === 0)) {
      return refuse("saved_search_id is required", 400, "saved_search_id");
    }
    const read = readMonitorFields(withName, mode === "update" ? existing : null);
    fields = read;
    source = "error" in read ? "search" : read.kind === "first_seen" ? "fingerprints" : "search";
  }
  if ("error" in fields) {
    return refuse(fields.error, fields.status);
  }
  return { ok: true, source, name, existing, place, fields };
}

/** The gate on a route that saves a monitor: what it saves, and whether it would. */
export function previewedPut(handler: Handler): Handler {
  return previewFirst(handler, (c) => ({ name: c.req.param("name") ?? "" }), (_c, body, target) => readDraft(body, target, "put").ok);
}

export function previewedCreate(handler: Handler): Handler {
  return previewFirst(
    handler,
    (_c, body) => (typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : null),
    (_c, body, target) => readDraft(body, target, "create").ok,
  );
}

export function previewedUpdate(handler: Handler): Handler {
  return previewFirst(handler, (c) => ({ id: c.req.param("id") ?? "" }), (_c, body, target) => readDraft(body, target, "update").ok);
}

/**
 * `POST /api/monitors/preview` (#360): a monitor's body, read as `PUT /api/monitors/:name` would
 * save it (or, with `id`, as `PUT /api/alert-rules/:id` would change that monitor), and where it
 * would have opened and resolved over the last 7 days. A body the save would refuse is refused
 * here in the same words. A body that passes counts as previewed, for this caller, for 10
 * minutes; a source with no past (push, HTTP(S), TCP, certificate, new fingerprints) still
 * counts, and says why it drew nothing. Nothing is stored but that.
 */
export async function monitorDraftPreviewRoute(c: Context): Promise<Response> {
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const byId = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : null;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!byId && !name) {
    return c.json({ error: "name is required: the monitor's name, as PUT /api/monitors/:name will have it (or id, to preview a change by id)", field: "name" }, 400);
  }
  const target: Target = byId ? { id: byId } : { name };
  const draft = readDraft(rec, target, byId ? "update" : "preview");
  if (!draft.ok) {
    return c.json({ error: draft.error, ...(draft.field ? { field: draft.field } : {}) }, draft.status);
  }
  const { source, place } = draft;
  const actor = actorOf(c);
  const now = Date.now();
  const seen = actor ? notePreview(actor.person.id, rec, target, now) : null;
  const head = {
    name: draft.name,
    ...(byId ? { id: byId } : {}),
    source,
    service: place.service,
    days: draftPreviewDays,
    /** Until when the save takes this same body without another preview. */
    saves_until: new Date(seen?.until ?? now + previewMs).toISOString(),
  };
  if (source !== "search") {
    return c.json({ ...head, previewed: false, cannot: cannotPreview[source] });
  }
  const monitor = draft.fields as MonitorFields;
  const saved = getSaved(monitor.saved_search_id)!;
  const window = saved.range && saved.range in previewWindows ? (saved.range as PreviewWindow) : null;
  const common = {
    ...head,
    saved_search: { id: saved.id, name: saved.name, query: saved.query, range: saved.range, agg: saved.agg },
    threshold: monitor.threshold,
    opens_when: monitor.opens_when,
    measure: monitor.measure,
  };
  if (!window) {
    return c.json({
      ...common,
      previewed: false,
      cannot: `A preview reads its saved search in windows of 5m, 15m or 1h; ${saved.name}'s window is ${saved.range ?? "a fixed from and to"}`,
    });
  }
  const read = await monitorPreview({
    q: saved.query,
    agg: saved.agg,
    opensWhen: monitor.opens_when,
    threshold: monitor.threshold,
    window,
    measure: monitor.measure,
    nowMs: now,
    spanMs: draftPreviewDays * dayMs,
  });
  const last = read.opens.at(-1);
  return c.json({
    ...common,
    previewed: read.refused === null,
    cannot: null,
    window,
    refused: read.refused,
    opened: read.opens.length,
    open_now: last !== undefined && last.to === null,
    open_ms: read.open_ms,
    stretches: read.opens.slice(-mostStretches).map((s) => ({ opened: s.from, resolved: s.to })),
    next: read.next,
    hourly: hourly(read.series, monitor.opens_when === "fewer_than"),
  });
}
