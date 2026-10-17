import {
  enabledAlertRules,
  pruneSentFingerprints,
  recordEvalAttempt,
  recordWebhookAttempt,
} from "../control/alerts";
import { getSaved } from "../control/saved-searches";
import { incMetric } from "../metrics";
import { parseRangeMs } from "../query/relative";
import { clipError, outcomeFromError, outcomeFromHttp } from "./delivery";
import { shouldDeliver } from "./evaluate";
import { publicUrl } from "../shared/public-url";
import {
  alertLink,
  alertWebhookBody,
  renderWebhook,
  thresholdFillValues,
  type WebhookPayload,
} from "./payload";
import { evaluateAlertSeries } from "./series";
import { evaluateFirstSeenRule, firstSeenDeps, firstSeenWatchMs } from "./first-seen";

const FALLBACK_COOLDOWN_MS = 5 * 60 * 1000;
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
  const rules = enabledAlertRules();
  pruneSentFingerprints(now - 2 * firstSeenWatchMs);
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
        await evaluateFirstSeenRule(rule, saved, now, firstSeenDeps(postWebhook));
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
    const cooldownMs = saved.range
      ? (parseRangeMs(saved.range) ?? FALLBACK_COOLDOWN_MS)
      : FALLBACK_COOLDOWN_MS;
    try {
      const series = await evaluateAlertSeries(saved);
      if (series.refused) {
        recordEvalAttempt(rule.id, {
          at: now,
          status: "refused",
          error: series.reason ?? "refused",
        });
        console.warn(
          `alert ${rule.id} skipped: ${series.reason ?? "refused"}`,
        );
        continue;
      }
      if (
        !shouldDeliver({
          refused: series.refused,
          value: series.value,
          threshold: rule.threshold,
          lastFiredAt: rule.last_fired_at,
          now,
          cooldownMs,
          silencedUntil: rule.silenced_until,
        })
      ) {
        recordEvalAttempt(rule.id, { at: now, status: "ok", error: null });
        continue;
      }
      const firedAt = new Date(now).toISOString();
      const base = publicUrl();
      // The window the series was read over: the saved range up to now, or its fixed from/to.
      const rangeMs = saved.range ? parseRangeMs(saved.range) : null;
      const from = rangeMs !== null ? new Date(now - rangeMs).toISOString() : saved.from_ts;
      const to = rangeMs !== null ? firedAt : saved.to_ts;
      const link =
        base && from && to
          ? alertLink(base, { savedId: saved.id, query: saved.query, agg: saved.agg, from, to })
          : null;
      const outcome = await postWebhook(
        rule.webhook_url,
        renderWebhook(
          rule,
          alertWebhookBody({
            url: rule.webhook_url,
            alert: {
              id: rule.id,
              name: rule.name,
              threshold: rule.threshold,
            },
            count: series.count,
            value: series.value,
            agg: series.expr,
            query: saved.query,
            firedAt,
            link,
          }),
          thresholdFillValues({
            name: rule.name,
            agg: series.expr,
            value: series.value,
            threshold: rule.threshold,
            query: saved.query,
            firedAt,
            link,
          }),
        ),
      );
      recordWebhookAttempt(rule.id, { at: now, ...outcome });
      if (outcome.ok) {
        incMetric("alert_fires");
      }
    } catch (err) {
      console.error("alert evaluation failed", err);
      recordEvalAttempt(rule.id, {
        at: now,
        status: "error",
        error: clipError(err instanceof Error ? err.message : String(err)),
      });
    }
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
