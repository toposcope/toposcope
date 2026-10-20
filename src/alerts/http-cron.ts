import { getAlert, recordWebhookAttempt } from "../control/alerts";
import { getDb } from "../control/index";
import { insertEvents } from "../ingest/index";
import { insertMetricPoints } from "../ingest/metrics";
import { incMetric } from "../metrics";
import { publicUrl } from "../shared/public-url";
import { postWebhook } from "./delivery";
import { runHttpMonitor, type HttpMonitorDeps } from "./http-monitor";
import { runHttpRequest } from "./http-request";
import { dueHttp, setNextRun } from "./http-store";

/**
 * HTTP(S) monitors run on their own clock (#178), not on the 60s alert pass: each second this
 * loop reads which enabled monitors are due (`monitor_http.next_run_at`), moves each one's next
 * run on by its `every` before it starts, and runs up to 8 at a time. A run in flight is never
 * started twice; a monitor that was due while Toposcope was down runs once, then keeps its pace.
 */

const tickMs = 1_000;
const maxInFlight = 8;
const running = new Set<string>();

export function httpMonitorDeps(): HttpMonitorDeps {
  return {
    db: getDb(),
    request: runHttpRequest,
    write: async (row, metric) => {
      await insertEvents([row]);
      if (metric) {
        await insertMetricPoints([metric]);
      }
    },
    post: postWebhook,
    publicUrl,
    recordWebhook: recordWebhookAttempt,
    onSent: () => incMetric("alert_fires"),
  };
}

/** When a run that starts now puts the next one: on its pace, or `every` from now when it fell behind. */
export function nextRunAt(scheduled: number | null, everyMs: number, now: number): number {
  const base = scheduled !== null && now - scheduled < everyMs ? scheduled : now;
  return base + everyMs;
}

/** Start every due monitor that is not already running. Resolves when the runs it started end. */
export async function tickHttpMonitors(now = Date.now(), deps: HttpMonitorDeps = httpMonitorDeps()): Promise<void> {
  const started: Promise<unknown>[] = [];
  for (const http of dueHttp(now, deps.db)) {
    if (running.has(http.monitor_id) || running.size >= maxInFlight) {
      continue;
    }
    const rule = getAlert(http.monitor_id, deps.db);
    if (!rule) {
      continue;
    }
    running.add(rule.id);
    setNextRun(rule.id, nextRunAt(http.next_run_at, http.every_ms, now), deps.db);
    started.push(
      runHttpMonitor(rule, http, now, deps)
        .catch((err) => console.error(`monitor ${rule.name} run failed`, err))
        .finally(() => running.delete(rule.id)),
    );
  }
  await Promise.all(started);
}

export function startHttpMonitors(): void {
  const timer = setInterval(() => {
    void tickHttpMonitors().catch((err) => console.error("http monitors tick failed", err));
  }, tickMs);
  // The server keeps the process up; this loop alone never should.
  timer.unref();
}
