import {
  enabledAlertRules,
  enabledPushMonitors,
  pruneSentFingerprints,
  recordEvalAttempt,
  recordWebhookAttempt,
} from "../control/alerts";
import { getDb } from "../control/index";
import { clickhouseQuery } from "../shared/clickhouse";
import { getSaved } from "../control/saved-searches";
import { getDefaultWebhook } from "../control/settings";
import { incMetric } from "../metrics";
import { clipError, outcomeFromError, outcomeFromHttp } from "./delivery";
import { publicUrl } from "../shared/public-url";
import type { WebhookPayload } from "./payload";
import { cantTellNow, markStarted } from "./cant-tell";
import { callUrl, passSearchMonitor, type CallDeps } from "./monitor";
import { passPushMonitor } from "./push";
import { closeByEdit, pruneResults, recordCall } from "./monitor-store";
import { pingWatchdog } from "./watchdog";
import { evaluateAlertSeries } from "./series";
import { evaluateFirstSeenRule, firstSeenDeps, firstSeenWatchMs } from "./first-seen";

const WEBHOOK_TIMEOUT_MS = 5000;

export async function postWebhook(
  url: string,
  payload: WebhookPayload,
): Promise<{ ok: boolean; status: string; error: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": payload.contentType },
      body: payload.body,
      signal: ac.signal,
      redirect: "error",
    });
    return outcomeFromHttp(res.status, res.statusText);
  } catch (err) {
    console.error("alert webhook failed", err);
    return outcomeFromError(err);
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateAlerts(now = Date.now()): Promise<void> {
  const db = getDb();
  const rules = enabledAlertRules(db);
  pruneSentFingerprints(now - 2 * firstSeenWatchMs);
  pruneResults(now, db);
  const calls: CallDeps = {
    db,
    post: postWebhook,
    publicUrl,
    recordWebhook: recordWebhookAttempt,
    // A monitor without a webhook of its own calls the one in Settings, if any (#177).
    defaultWebhook: () => getDefaultWebhook(db),
    onSent: () => incMetric("alert_fires"),
  };
  for (const rule of rules) {
    if (!rule.saved_search_id || rule.source === "push") {
      continue;
    }
    const saved = getSaved(rule.saved_search_id);
    if (!saved || saved.board) {
      // Its saved search is gone, or became a board: nothing reads it any more, so an open
      // stretch closes as an edit closes it, without a call.
      if (rule.state === "open") {
        closeByEdit(rule.id, now, db);
      }
      continue;
    }
    if (rule.kind === "first_seen") {
      // It never opens, so it has no state to keep: with nobody to call it is not read.
      const url = callUrl(rule, calls);
      if (!url) {
        continue;
      }
      try {
        await evaluateFirstSeenRule({ ...rule, webhook_url: url }, saved, now, {
          ...firstSeenDeps(postWebhook),
          // Each call is kept with the monitor, outside any stretch: it never opens.
          recordWebhook: (ruleId, attempt) => {
            recordWebhookAttempt(ruleId, attempt);
            recordCall({
              monitor_id: ruleId,
              stretch_id: null,
              at: attempt.at,
              what: "sent",
              status: attempt.status,
              ok: attempt.ok,
              error: attempt.error,
            });
          },
        });
      } catch (err) {
        console.error("alert evaluation failed", err);
        recordEvalAttempt(rule.id, {
          at: now,
          status: "error",
          error: clipError(err instanceof Error ? err.message : String(err)),
        });
      }
      continue;
    }
    // Read whether or not anybody is called: its state is kept either way.
    await passSearchMonitor(rule, saved, now, {
      ...calls,
      read: evaluateAlertSeries,
      recordEval: (id, stamp, database) =>
        recordEvalAttempt(id, { ...stamp, error: stamp.error ? clipError(stamp.error) : null }, database),
      cantTell: (s, windowMs, at) => cantTellNow(s.query, windowMs, at),
    });
  }
  // Push monitors (#177): late past `every`, open past `every` + `grace`; read from SQLite alone.
  for (const rule of enabledPushMonitors(db)) {
    try {
      await passPushMonitor(rule.id, now, calls);
    } catch (err) {
      console.error("push monitor pass failed", err);
    }
  }
}

const storesTimeoutMs = 10_000;

/** ClickHouse answers a query (SQLite was read for the rules): a pass with no monitors proves it too. */
async function storesAnswer(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      clickhouseQuery<{ ok: number }>("SELECT 1 AS ok").then((rows) => Number(rows[0]?.ok) === 1),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), storesTimeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** What a tick runs; tests swap them. */
export const monitorLoop = {
  evaluate: (now?: number) => evaluateAlerts(now),
  storesAnswer,
  checkIn: (ok: boolean) => pingWatchdog(ok),
};

let passRunning = false;

/**
 * One tick of the monitor loop: a pass over every monitor, then the watchdog's check-in (#179),
 * `ok` when the pass read its stores. A tick while the last pass is still running is skipped, so
 * two passes never send one call twice; a stuck pass sends no check-in, and the outside service
 * notices.
 */
export async function monitorTick(now?: number): Promise<"skipped" | "ok" | "fail"> {
  if (passRunning) {
    console.warn("monitor pass still running: this tick is skipped");
    return "skipped";
  }
  passRunning = true;
  try {
    let ok = true;
    try {
      await monitorLoop.evaluate(now);
    } catch (err) {
      ok = false;
      console.error("monitor pass failed", err);
    }
    ok = ok && (await monitorLoop.storesAnswer());
    await monitorLoop.checkIn(ok);
    return ok ? "ok" : "fail";
  } finally {
    passRunning = false;
  }
}

export function startAlertCron(): void {
  const raw = process.env.ALERT_CRON_MS;
  const ms = raw !== undefined && raw !== "" ? Number(raw) : 60_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  // Ingest is answered from here: a fewer-than window that reaches back before it may miss lines.
  markStarted();
  setInterval(() => {
    void monitorTick();
  }, ms);
}
