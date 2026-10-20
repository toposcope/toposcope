import type { Context } from "hono";
import {
  kindThreshold,
  parseAlertKind,
  parseWebhook,
  readBody,
  readJsonObject,
} from "../control/alerts";
import { getSaved } from "../control/saved-searches";
import { compileQuery } from "../query/compile";
import { fingerprintCutFirstSeen, firstSeenDetails } from "../query/fingerprint-cut";
import { changeMarksBetween } from "../query/marks";
import { parseRangeMs } from "../query/relative";
import { publicUrl } from "../shared/public-url";
import { boardWatchRefuse } from "../shared/boards";
import { fewerThanProblem, parseOpensWhen } from "../shared/monitor";
import { parseThreshold } from "./threshold";
import { firstSeenPayload, firstSeenWatchMs, watchedMarks } from "./first-seen";
import { getDefaultWebhook } from "../control/settings";
import { monitorQuery } from "../shared/push";
import {
  alertLink,
  alertWebhookBody,
  httpCallBody,
  httpFillValues,
  readingMessage,
  renderResolved,
  renderWebhook,
  thresholdFillValues,
  type WebhookPayload,
} from "./payload";
import { evaluateAlertSeries } from "./series";

const TEST_TIMEOUT_MS = 5000;
/** The reply shown, as its first 200 characters. */
export const testReplyChars = 200;

export type TestCallResult = {
  ok: boolean;
  /** HTTP status, or null when nothing came back. */
  status: number | null;
  status_text: string;
  ms: number;
  at: string;
  reply: string;
  sent: string;
  content_type: string;
  /** With a resolved body, it is sent after the open one (18t). */
  resolved?: Omit<TestCallResult, "resolved"> | null;
};

/** Post one call and say what came back: status, time, the reply's first 200 characters. */
export async function sendTestCall(
  url: string,
  payload: WebhookPayload,
  now: () => number = Date.now,
): Promise<TestCallResult> {
  const started = now();
  const at = new Date(started).toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": payload.contentType },
      body: payload.body,
      signal: ac.signal,
      redirect: "error",
    });
    const text = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      status_text: res.statusText,
      ms: Math.max(0, now() - started),
      at,
      reply: text.slice(0, testReplyChars),
      sent: payload.body,
      content_type: payload.contentType,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      status: null,
      status_text: aborted ? "timed out" : err instanceof Error ? err.message : String(err),
      ms: Math.max(0, now() - started),
      at,
      reply: "",
      sent: payload.body,
      content_type: payload.contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `POST /api/alert-rules/test-call` — the dialog's Send a test call: the draft as it stands,
 * filled in from the last evaluation (a threshold alert) or the last mark it watched.
 */
export async function testAlertCallRoute(c: Context): Promise<Response> {
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  if (rec.source === "http") {
    return testHttpCall(c, rec);
  }
  const kind = rec.kind === undefined ? "threshold" : parseAlertKind(rec.kind);
  if (!kind) {
    return c.json({ error: "kind must be threshold or first_seen" }, 400);
  }
  const webhook = parseWebhook(rec.webhook_url);
  if (typeof webhook !== "string") {
    return c.json({ error: webhook.error }, 400);
  }
  const parsed = parseThreshold(rec.threshold);
  const threshold = typeof parsed === "number" ? kindThreshold(kind, parsed) : parsed;
  if (typeof threshold !== "number") {
    return c.json({ error: threshold.error }, 400);
  }
  const body = readBody(rec, kind, null);
  if ("error" in body) {
    return c.json({ error: body.error }, 400);
  }
  const opensWhen = rec.opens_when === undefined || kind === "first_seen" ? "at_least" : parseOpensWhen(rec.opens_when);
  if (!opensWhen) {
    return c.json({ error: "opens_when must be at_least or fewer_than" }, 400);
  }
  const savedId = typeof rec.saved_search_id === "string" ? rec.saved_search_id : "";
  const saved = savedId ? getSaved(savedId) : null;
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardWatchRefuse(saved) }, 400);
  }
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : saved.name;
  const rule = { id: typeof rec.id === "string" ? rec.id : "test", name, threshold, webhook_url: webhook, ...body };
  const now = Date.now();
  const firedAt = new Date(now).toISOString();
  let payload: WebhookPayload;
  let resolvedPayload: WebhookPayload | null = null;
  if (kind === "first_seen") {
    const compiled = compileQuery(saved.query ?? "");
    if (compiled.faults.length > 0) {
      return c.json({ error: compiled.faults[0]?.msg ?? "the saved search's q does not compile" }, 400);
    }
    const marks = watchedMarks(
      await changeMarksBetween(new Date(now - firstSeenWatchMs).toISOString(), firedAt),
      compiled,
      now,
    );
    const mark = marks.at(-1);
    if (!mark) {
      return c.json({ error: "No deploy or flag mark in the last 24 hours to fill this in from." }, 400);
    }
    const cut = await fingerprintCutFirstSeen({ mark, compiled, now });
    if (cut.refused) {
      return c.json({ error: `The cut after ${mark.title} was refused: ${cut.refused}.` }, 400);
    }
    // A test lists what the alert would list for that mark, sent before or not.
    const fresh = cut.firstSeen
      .filter((row) => row.after >= threshold)
      .sort((a, b) => b.after - a.after || a.hex.localeCompare(b.hex));
    payload = await firstSeenPayload({
      rule,
      saved,
      mark,
      windows: cut.windows,
      fresh,
      compiled,
      now,
      deps: { details: firstSeenDetails, publicUrl },
    });
  } else {
    const problem = opensWhen === "fewer_than" ? fewerThanProblem(saved) : null;
    if (problem) {
      return c.json({ error: problem }, 400);
    }
    const series = await evaluateAlertSeries(saved);
    if (series.refused) {
      return c.json({ error: series.reason ?? "This series cannot be evaluated." }, 400);
    }
    const base = publicUrl();
    const rangeMs = saved.range ? parseRangeMs(saved.range) : null;
    const from = rangeMs !== null ? new Date(now - rangeMs).toISOString() : saved.from_ts;
    const to = rangeMs !== null ? firedAt : saved.to_ts;
    const link =
      base && from && to
        ? alertLink(base, { savedId: saved.id, query: saved.query, agg: saved.agg, from, to })
        : null;
    // Sent as the call that opens it would be.
    const call = { state: "open" as const, openedAt: firedAt, resolvedAt: null, duration: "0s" };
    const message = readingMessage(series.expr, series.value, threshold, opensWhen, saved.range);
    // A resolved body of its own is tried too, as the call that resolves it would read.
    if (body.body_kind !== "default" && body.resolved_body) {
      resolvedPayload = renderResolved(
        rule,
        {},
        thresholdFillValues({
          name,
          agg: series.expr,
          value: series.value,
          threshold,
          query: saved.query,
          firedAt,
          link,
          call: { state: "resolved", openedAt: firedAt, resolvedAt: firedAt, duration: "0s" },
          message,
        }),
      );
    }
    payload = renderWebhook(
      rule,
      alertWebhookBody({
        url: webhook,
        alert: { id: rule.id, name, threshold, ...(opensWhen === "fewer_than" ? { opens_when: opensWhen } : {}) },
        count: series.count,
        value: series.value,
        agg: series.expr,
        query: saved.query,
        firedAt,
        link,
        call,
      }),
      thresholdFillValues({
        name,
        agg: series.expr,
        value: series.value,
        threshold,
        query: saved.query,
        firedAt,
        link,
        call,
        message,
      }),
    );
  }
  const opened = await sendTestCall(webhook, payload);
  const resolved = resolvedPayload ? await sendTestCall(webhook, resolvedPayload) : null;
  return c.json({ ...opened, resolved });
}

/**
 * An HTTP(S) monitor's test call (#178): its body as the call that opens it would be, filled in
 * from the editor's last Send (`run`: status, duration_ms, why), then its resolved body.
 */
async function testHttpCall(c: Context, rec: Record<string, unknown>): Promise<Response> {
  // Its own webhook, else the default in Settings: the one its calls would go to.
  const own = rec.webhook_url === undefined || rec.webhook_url === null || rec.webhook_url === "" ? null : parseWebhook(rec.webhook_url);
  if (own !== null && typeof own !== "string") {
    return c.json({ error: own.error }, 400);
  }
  const webhook = own ?? getDefaultWebhook();
  if (!webhook) {
    return c.json({ error: "No webhook to call: give this monitor one, or set the default in Settings" }, 400);
  }
  const body = readBody(rec, "http", null);
  if ("error" in body) {
    return c.json({ error: body.error }, 400);
  }
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : "this monitor";
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  const method = typeof rec.method === "string" ? rec.method.toUpperCase() : "GET";
  const run = (rec.run && typeof rec.run === "object" ? rec.run : {}) as Record<string, unknown>;
  const status = typeof run.status === "number" ? run.status : null;
  const durationMs = typeof run.duration_ms === "number" ? run.duration_ms : 0;
  const message =
    typeof run.why === "string" && run.why ? run.why : status !== null ? `${status} in ${durationMs}ms` : "no response yet";
  const now = Date.now();
  const firedAt = new Date(now).toISOString();
  const base = publicUrl();
  const link = base
    ? `${base}/?${new URLSearchParams({ q: monitorQuery(name), range: "1h" }).toString()}`
    : null;
  const rule = { id: typeof rec.id === "string" ? rec.id : "test", name, webhook_url: webhook, ...body };
  const facts = (state: "open" | "resolved") => ({
    alert: { id: rule.id, name },
    method,
    url,
    status,
    durationMs,
    message,
    firedAt,
    link,
    call: { state, openedAt: firedAt, resolvedAt: state === "resolved" ? firedAt : null, duration: "0s" },
  });
  const payload = renderWebhook(rule, httpCallBody(webhook, facts("open")), httpFillValues(facts("open")));
  const resolvedPayload =
    body.body_kind !== "default" && body.resolved_body
      ? renderResolved(rule, {}, httpFillValues(facts("resolved")))
      : null;
  const opened = await sendTestCall(webhook, payload);
  const resolved = resolvedPayload ? await sendTestCall(webhook, resolvedPayload) : null;
  return c.json({ ...opened, resolved });
}
