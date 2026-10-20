import type { Context } from "hono";
import { sendHttpCheck } from "../alerts/http-monitor";
import { runHttpRequest } from "../alerts/http-request";
import {
  forgetHttp,
  getHttp,
  insertHttp,
  updateHttp,
  type HttpLastRun,
  type HttpSettings,
  type HttpWrite,
} from "../alerts/http-store";
import { closeByEdit } from "../alerts/monitor-store";
import {
  defaultFailAfter,
  defaultHttpEvery,
  formatConditions,
  formatHttpEvery,
  httpHeaderProblem,
  httpMethods,
  httpUrlProblem,
  maxFailAfter,
  maxHttpBody,
  maxHttpHeaders,
  parseConditions,
  parseHttpEvery,
  type ConditionLine,
  type HttpMethod,
} from "../shared/http-check";
import type { AlertBodyKind } from "../shared/alert-body";
import type { RemindId } from "../shared/monitor";
import { getAlert, parseWebhook, readBody, readJsonObject, readRemind, type AlertRule } from "./alerts";
import { getDb } from "./index";

/** An HTTP(S) monitor as the API shows it: its headers by name only, never their values. */
export type HttpView = {
  url: string;
  method: HttpMethod;
  body: string | null;
  headers: string[];
  every: string;
  every_ms: number;
  conditions: string;
  fail_after: number;
  fails_in_row: number;
  next_run_at: number | null;
  last_run: HttpLastRun | null;
};

export function httpView(http: HttpSettings): HttpView {
  return {
    url: http.url,
    method: http.method,
    body: http.body,
    headers: http.headers.map(([name]) => name),
    every: formatHttpEvery(http.every_ms),
    every_ms: http.every_ms,
    conditions: http.conditions,
    fail_after: http.fail_after,
    fails_in_row: http.fails_in_row,
    next_run_at: http.next_run_at,
    last_run: http.last_run,
  };
}

export type HttpFields = {
  name: string;
  write: HttpWrite;
  webhook_url: string;
  body_kind: AlertBodyKind;
  body_template: string | null;
  resolved_body: string | null;
  remind_every: RemindId;
};

type FieldsError = { error: string; status: 400 | 404 };

type Existing = { rule: AlertRule; http: HttpSettings } | null;

/**
 * Headers, as `{ "Authorization": "Bearer …" }` or `[["Authorization", "Bearer …"]]`. A value of
 * null keeps the one stored under that name, so the editor never has to be shown it.
 */
export function readHeaders(raw: unknown, stored: ReadonlyArray<readonly [string, string]>): Array<[string, string]> | { error: string } {
  const pairs: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((h) => (Array.isArray(h) ? [String(h[0] ?? ""), h[1]] : ["", h]))
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  if (!Array.isArray(raw) && (raw === null || typeof raw !== "object")) {
    return { error: "headers must be an object of name: value" };
  }
  if (pairs.length > maxHttpHeaders) {
    return { error: `at most ${maxHttpHeaders} headers` };
  }
  const out: Array<[string, string]> = [];
  for (const [nameRaw, valueRaw] of pairs) {
    const name = nameRaw.trim();
    let value: string;
    if (valueRaw === null) {
      const kept = stored.find(([k]) => k.toLowerCase() === name.toLowerCase());
      if (!kept) {
        return { error: `header ${name} has no stored value to keep` };
      }
      value = kept[1];
    } else if (typeof valueRaw === "string") {
      value = valueRaw.trim();
    } else {
      return { error: `header ${name} must be a string` };
    }
    const problem = httpHeaderProblem(name, value);
    if (problem) {
      return { error: problem };
    }
    if (out.some(([k]) => k.toLowerCase() === name.toLowerCase())) {
      return { error: `header ${name} is given twice` };
    }
    out.push([name, value]);
  }
  return out;
}

/** The lines, as text (one a line) or as a list; stored as `formatConditions` writes them. */
export function readConditions(raw: unknown): { lines: ConditionLine[]; text: string } | { error: string } {
  const text = Array.isArray(raw) ? raw.map((l) => String(l)).join("\n") : typeof raw === "string" ? raw : null;
  if (text === null) {
    return { error: "conditions must be lines of text" };
  }
  const parsed = parseConditions(text);
  if ("error" in parsed) {
    return { error: `conditions ${parsed.error}` };
  }
  return { lines: parsed, text: formatConditions(parsed) };
}

/** What a monitor calls, as a create, an update or the editor's Send gives it. */
export function readHttpCheck(
  rec: Record<string, unknown>,
  stored: Pick<HttpSettings, "url" | "method" | "body" | "headers" | "conditions"> | null,
  storedHeaders: ReadonlyArray<readonly [string, string]> = stored?.headers ?? [],
): { url: string; method: HttpMethod; body: string | null; headers: Array<[string, string]>; lines: ConditionLine[]; conditions: string } | { error: string } {
  const url = typeof rec.url === "string" ? rec.url.trim() : (stored?.url ?? "");
  const urlProblem = httpUrlProblem(url);
  if (urlProblem) {
    return { error: urlProblem };
  }
  const methodRaw = rec.method === undefined ? (stored?.method ?? "GET") : String(rec.method).toUpperCase();
  if (!(httpMethods as readonly string[]).includes(methodRaw)) {
    return { error: "method must be GET, HEAD or POST" };
  }
  const method = methodRaw as HttpMethod;
  const bodyRaw = rec.body === undefined ? (stored?.body ?? null) : rec.body;
  if (bodyRaw !== null && typeof bodyRaw !== "string") {
    return { error: "body must be text" };
  }
  const bodyText = bodyRaw && bodyRaw.length > 0 ? bodyRaw : null;
  if (bodyText && method !== "POST" && rec.body !== undefined) {
    return { error: "a body is sent with POST only" };
  }
  if (bodyText && bodyText.length > maxHttpBody) {
    return { error: `body is longer than ${maxHttpBody} characters` };
  }
  const headers =
    rec.headers === undefined
      ? (stored?.headers.map(([k, v]) => [k, v] as [string, string]) ?? [])
      : readHeaders(rec.headers, storedHeaders);
  if ("error" in headers) {
    return headers;
  }
  const conditions = readConditions(rec.conditions === undefined ? (stored?.conditions ?? "") : rec.conditions);
  if ("error" in conditions) {
    return conditions;
  }
  return {
    url,
    method,
    body: method === "POST" ? bodyText : null,
    headers,
    lines: conditions.lines,
    conditions: conditions.text,
  };
}

/**
 * An HTTP(S) monitor's fields. With `existing` (an update), a field left out keeps its value;
 * without it (a create, or a replace by name), it takes its default. Either way a header given
 * as null keeps the value stored under that name.
 */
export function readHttpFields(
  rec: Record<string, unknown>,
  existing: Existing,
  storedHeaders: ReadonlyArray<readonly [string, string]> = existing?.http.headers ?? [],
): HttpFields | FieldsError {
  const nameRaw = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameRaw.length > 0 ? nameRaw : (existing?.rule.name ?? "");
  if (name.length === 0) {
    return { error: "name is required", status: 400 };
  }
  const check = readHttpCheck(rec, existing?.http ?? null, storedHeaders);
  if ("error" in check) {
    return { error: check.error, status: 400 };
  }
  const everyMs =
    rec.every === undefined ? (existing?.http.every_ms ?? parseHttpEvery(defaultHttpEvery)!) : parseHttpEvery(rec.every);
  if (everyMs === null) {
    return { error: "every must be 30s … 1h: 30s, 1m, 5m, 15m, 30m or 1h", status: 400 };
  }
  const failAfter = rec.fail_after === undefined ? (existing?.http.fail_after ?? defaultFailAfter) : rec.fail_after;
  if (typeof failAfter !== "number" || !Number.isInteger(failAfter) || failAfter < 1 || failAfter > maxFailAfter) {
    return { error: `fail_after must be a whole number of runs, 1 to ${maxFailAfter}`, status: 400 };
  }
  const webhook =
    rec.webhook_url === undefined && existing ? (existing.rule.webhook_url ?? "") : parseWebhook(rec.webhook_url);
  if (typeof webhook !== "string" || webhook.length === 0) {
    return { error: "webhook_url must be http(s)", status: 400 };
  }
  const body = readBody(rec, "http", existing?.rule ?? null);
  if ("error" in body) {
    return { error: body.error, status: 400 };
  }
  const remind = readRemind(rec, existing?.rule ?? null);
  if (typeof remind !== "string") {
    return { error: remind.error, status: 400 };
  }
  if (remind === "window") {
    return { error: "remind_every must be off, 1h, 4h or 24h", status: 400 };
  }
  return {
    name,
    write: {
      url: check.url,
      method: check.method,
      body: check.body,
      headers: check.headers,
      every_ms: everyMs,
      conditions: check.conditions,
      fail_after: failAfter,
    },
    webhook_url: webhook,
    ...body,
    remind_every: remind,
  };
}

/** A new HTTP(S) monitor: ok, and its first run is due now. */
export function insertHttpMonitor(fields: HttpFields, now = Date.now()): AlertRule {
  const id = crypto.randomUUID();
  const db = getDb();
  db.transaction(() => {
    db.query(
      `INSERT INTO alert_rules
        (id, name, query, webhook_url, saved_search_id, threshold, enabled, last_fired_at, created_at, kind, body_kind, body_template,
         source, state, remind_every, resolved_body)
       VALUES (?, ?, '', ?, NULL, 1, 1, NULL, ?, 'http', ?, ?, 'http', 'ok', ?, ?)`,
    ).run(
      id,
      fields.name,
      fields.webhook_url,
      now,
      fields.body_kind,
      fields.body_template,
      fields.remind_every,
      fields.resolved_body,
    );
    insertHttp(id, fields.write, now, db);
  })();
  return getAlert(id)!;
}

function sameHeaders(a: ReadonlyArray<readonly [string, string]>, b: ReadonlyArray<readonly [string, string]>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Write an HTTP(S) monitor's fields over what it was. When what it calls or its lines change,
 * an open stretch closes without a call, its failures in a row start over, and it runs now.
 */
export function applyHttpFields(existing: AlertRule, http: HttpSettings, fields: HttpFields, now = Date.now()): void {
  const db = getDb();
  const w = fields.write;
  const readsAnew =
    w.url !== http.url ||
    w.method !== http.method ||
    w.body !== http.body ||
    !sameHeaders(w.headers, http.headers) ||
    w.conditions !== http.conditions;
  const nextRunAt = readsAnew
    ? now
    : w.every_ms !== http.every_ms
      ? Math.max(now, (http.last_run?.at ?? now) + w.every_ms)
      : (http.next_run_at ?? now);
  db.transaction(() => {
    db.query(
      `UPDATE alert_rules SET name = ?, webhook_url = ?, body_kind = ?, body_template = ?, remind_every = ?, resolved_body = ?
       WHERE id = ?`,
    ).run(
      fields.name,
      fields.webhook_url,
      fields.body_kind,
      fields.body_template,
      fields.remind_every,
      fields.resolved_body,
      existing.id,
    );
    updateHttp(existing.id, w, { nextRunAt, restart: readsAnew }, db);
  })();
  if (readsAnew && existing.state === "open") {
    closeByEdit(existing.id, now);
  }
  if (fields.webhook_url !== (existing.webhook_url ?? "")) {
    db.query(
      `UPDATE alert_rules SET last_attempt_at = NULL, last_status = NULL, last_error = NULL, consecutive_failures = 0
       WHERE id = ?`,
    ).run(existing.id);
  }
}

export function existingHttp(rule: AlertRule): Existing {
  const http = rule.source === "http" ? getHttp(rule.id) : null;
  return http ? { rule, http } : null;
}

export { forgetHttp };

/** The body the editor is shown: enough to pick values from. */
const shownBody = 256 * 1024;

/**
 * `POST /api/monitors/send` — the editor's Send (18r): the request run once from this node, and
 * what came back: status, headers, body, where the time went, the certificate, and what each
 * line makes of it. Nothing is stored. With `id`, a header given as null is that monitor's own.
 */
export async function sendHttpRoute(c: Context): Promise<Response> {
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const rule = typeof rec.id === "string" ? getAlert(rec.id) : null;
  const stored = rule?.source === "http" ? getHttp(rule.id) : null;
  const check = readHttpCheck({ conditions: "", ...rec }, null, stored?.headers ?? []);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const at = Date.now();
  const run = await sendHttpCheck(check, runHttpRequest);
  const x = run.exchange;
  return c.json({
    at,
    url: check.url,
    method: check.method,
    response: x.ok
      ? {
          status: x.status,
          status_text: x.status_text,
          http_version: x.http_version,
          headers: x.headers,
          body: x.body.slice(0, shownBody),
          body_bytes: x.body_bytes,
          truncated: x.truncated || x.body.length > shownBody,
        }
      : null,
    error: x.ok ? null : x.error,
    timings: x.timings,
    cert: x.cert,
    duration_ms: run.durationMs,
    verdict: {
      result: run.verdict.result,
      line: run.verdict.line,
      why: run.verdict.why,
      lines: check.lines.map((l, i) => ({ text: l.text, level: l.level, ...run.verdict.lines[i]! })),
    },
  });
}
