import { getAlert, recordWebhookAttempt, type AlertRule } from "../control/alerts";
import { getDb } from "../control/index";
import { getDefaultWebhook } from "../control/settings";
import { insertEvents } from "../ingest/index";
import { insertMetricPoints } from "../ingest/metrics";
import { incMetric } from "../metrics";
import { publicUrl } from "../shared/public-url";
import { postWebhook } from "./delivery";
import { runHttpMonitor, type HttpMonitorDeps } from "./http-monitor";
import { runHttpRequest } from "./http-request";
import { dueHttp, setNextRun } from "./http-store";
import { runNetMonitor, type NetMonitorDeps } from "./net-monitor";
import { runNetRequest } from "./net-request";
import { dueNet, setNetNextRun } from "./net-store";

/**
 * Checks from this node run on their own clock, not on the 60s alert pass: HTTP(S) monitors
 * (#178), and TCP and certificate monitors (#180). Each second this loop reads which enabled
 * monitors are due (`monitor_http.next_run_at`, `monitor_net.next_run_at`), moves each one's next
 * run on by its `every` before it starts, and runs up to 8 at a time. A run in flight is never
 * started twice; a monitor that was due while Toposcope was down runs once, then keeps its pace.
 */

const tickMs = 1_000;
const maxInFlight = 8;
const running = new Set<string>();

export function httpMonitorDeps(): HttpMonitorDeps & NetMonitorDeps {
  const db = getDb();
  return {
    db,
    request: runHttpRequest,
    connect: runNetRequest,
    write: async (row, metric) => {
      await insertEvents([row]);
      if (metric) {
        await insertMetricPoints([metric]);
      }
    },
    post: postWebhook,
    publicUrl,
    recordWebhook: recordWebhookAttempt,
    // A monitor without a webhook of its own calls the one in Settings, if any (#177).
    defaultWebhook: () => getDefaultWebhook(db),
    onSent: () => incMetric("alert_fires"),
  };
}

/** When a run that starts now puts the next one: on its pace, or `every` from now when it fell behind. */
export function nextRunAt(scheduled: number | null, everyMs: number, now: number): number {
  const base = scheduled !== null && now - scheduled < everyMs ? scheduled : now;
  return base + everyMs;
}

/** Start every due monitor that is not already running. Resolves when the runs it started end. */
export async function tickHttpMonitors(
  now = Date.now(),
  deps: HttpMonitorDeps & Partial<Pick<NetMonitorDeps, "connect">> = httpMonitorDeps(),
): Promise<void> {
  const started: Promise<unknown>[] = [];
  const start = (id: string, nextAt: (ruleId: string) => void, run: (rule: AlertRule) => Promise<unknown>) => {
    if (running.has(id) || running.size >= maxInFlight) {
      return;
    }
    const rule = getAlert(id, deps.db);
    if (!rule) {
      return;
    }
    running.add(rule.id);
    nextAt(rule.id);
    started.push(
      run(rule)
        .catch((err) => console.error(`monitor ${rule.name} run failed`, err))
        .finally(() => running.delete(rule.id)),
    );
  };
  for (const http of dueHttp(now, deps.db)) {
    start(
      http.monitor_id,
      (id) => setNextRun(id, nextRunAt(http.next_run_at, http.every_ms, now), deps.db),
      (rule) => runHttpMonitor(rule, http, now, deps),
    );
  }
  const connect = deps.connect;
  if (connect) {
    for (const net of dueNet(now, deps.db)) {
      start(
        net.monitor_id,
        (id) => setNetNextRun(id, nextRunAt(net.next_run_at, net.every_ms, now), deps.db),
        (rule) => runNetMonitor(rule, net, now, { ...deps, connect }),
      );
    }
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
