import {
  enabledAlertRules,
  pruneSentFingerprints,
  recordEvalAttempt,
  recordWebhookAttempt,
} from "../control/alerts";
import { getDb } from "../control/index";
import { getSaved } from "../control/saved-searches";
import { incMetric } from "../metrics";
import { clipError, postWebhook } from "./delivery";
import { publicUrl } from "../shared/public-url";
import { passSearchMonitor } from "./monitor";
import { pruneResults, recordCall } from "./monitor-store";
import { evaluateAlertSeries } from "./series";
import { evaluateFirstSeenRule, firstSeenDeps, firstSeenWatchMs } from "./first-seen";

export async function evaluateAlerts(now = Date.now()): Promise<void> {
  const db = getDb();
  const rules = enabledAlertRules(db);
  pruneSentFingerprints(now - 2 * firstSeenWatchMs);
  pruneResults(now, db);
  for (const rule of rules) {
    if (!rule.saved_search_id || !rule.webhook_url) {
      continue;
    }
    const saved = getSaved(rule.saved_search_id);
    if (!saved || saved.board) {
      continue;
    }
    if (rule.kind === "first_seen") {
      try {
        await evaluateFirstSeenRule(rule, saved, now, {
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
    await passSearchMonitor(rule, saved, now, {
      db,
      read: evaluateAlertSeries,
      post: postWebhook,
      publicUrl,
      recordWebhook: recordWebhookAttempt,
      recordEval: (id, stamp, database) =>
        recordEvalAttempt(id, { ...stamp, error: stamp.error ? clipError(stamp.error) : null }, database),
      onSent: () => incMetric("alert_fires"),
    });
  }
}

export function startAlertCron(): void {
  const raw = process.env.ALERT_CRON_MS;
  const ms = raw !== undefined && raw !== "" ? Number(raw) : 60_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  setInterval(() => {
    void evaluateAlerts();
  }, ms);
}
