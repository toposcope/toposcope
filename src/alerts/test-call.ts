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
import { parseThreshold } from "./threshold";
import { firstSeenPayload, firstSeenWatchMs, watchedMarks } from "./first-seen";
import {
  alertLink,
  alertWebhookBody,
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
    payload = renderWebhook(
      rule,
      alertWebhookBody({
        url: webhook,
        alert: { id: rule.id, name, threshold },
        count: series.count,
        value: series.value,
        agg: series.expr,
        query: saved.query,
        firedAt,
        link,
      }),
      thresholdFillValues({
        name,
        agg: series.expr,
        value: series.value,
        threshold,
        query: saved.query,
        firedAt,
        link,
      }),
    );
  }
  return c.json(await sendTestCall(webhook, payload));
}
