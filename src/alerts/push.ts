import type { Database } from "bun:sqlite";
import { getAlert, type AlertRule } from "../control/alerts";
import { formatOpenFor } from "../shared/monitor";
import {
  pushDueAt,
  pushOpensAt,
  type CheckStatus,
  type CheckVia,
} from "../shared/push";
import { fallbackWindowMs, nextMove, passCalls, type CallDeps } from "./monitor";
import { recordPushResult } from "./monitor-results";
import {
  beginStretch,
  noteReading,
  openStretch,
  recordResult,
  resolveStretch,
  type CallWhat,
  type MonitorStretch,
} from "./monitor-store";
import {
  alertLink,
  pushFillValues,
  pushWebhookBody,
  renderResolved,
  renderWebhook,
  sendsResolved,
  type WebhookPayload,
} from "./payload";

/** One pushed result (#177), from `POST /v1/checks`, a ping, or an attached probe. */
export type PushResult = {
  monitor: string;
  status: CheckStatus;
  message: string;
  value: number | null;
  unit: string | null;
  /** Left out (undefined) keeps the monitor's; a span sets it. */
  every_ms?: number;
  grace_ms?: number;
  host: string;
  service: string;
  /** When it happened, ISO; its log row's time. */
  ts: string;
  exit_code: number | null;
  /** From its own sender, or from the monitor's `/start`. */
  duration_ms: number | null;
  via: CheckVia;
  /** Who sent it, for Watch: its host, or a ping's address. */
  from: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** "fail · exit 2": a result that says nothing more, in words. */
export function resultWords(result: Pick<PushResult, "status" | "message" | "exit_code">): string {
  if (result.message.trim()) {
    return result.message.trim().split("\n", 1)[0]!.slice(0, 500);
  }
  return result.exit_code !== null ? `${result.status} · exit ${result.exit_code}` : result.status;
}

/**
 * A result arrives for a push monitor (#177): it is kept for Watch, its next result is due
 * counted from now, and a run it ends is over. A fail opens it, the first ok after that
 * resolves it, a warn shows and changes nothing, and unknown changes nothing at all. A paused
 * monitor keeps its results and does not open.
 */
export async function applyPushResult(rule: AlertRule, result: PushResult, now: number, db: Database): Promise<void> {
  db.transaction(() => {
    db.query(
      `UPDATE alert_rules SET due_from = ?, started_at = NULL,
         every_ms = CASE WHEN ? THEN ? ELSE every_ms END,
         grace_ms = CASE WHEN ? THEN ? ELSE grace_ms END,
         last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END
       WHERE id = ?`,
    ).run(
      now,
      result.every_ms !== undefined ? 1 : 0,
      result.every_ms ?? null,
      result.grace_ms !== undefined ? 1 : 0,
      result.grace_ms ?? null,
      result.status === "ok" ? 1 : 0,
      now,
      rule.id,
    );
    if (result.status === "unknown") {
      return;
    }
    recordResult(rule.id, result.status, result.value, now, db);
    if (rule.enabled === 0) {
      return;
    }
    const reading = { value: result.value, count: null, message: resultWords(result) };
    const open = openStretch(rule.id, db);
    switch (nextMove(open ? "open" : "ok", result.status)) {
      case "open":
        beginStretch(rule.id, now, reading, db);
        break;
      case "still-open":
        noteReading(open!.id, now, reading, db);
        break;
      case "resolve":
        resolveStretch(rule.id, open!.id, now, reading, db);
        break;
      default:
        break;
    }
  })();
  // Unknown changes nothing, Watch's ticks included; its log row is its record. Kept in
  // ClickHouse (#324), so after the monitor's own state, which a failed write must not hold back.
  if (result.status !== "unknown") {
    await recordPushResult({
      monitor_id: rule.id,
      at: Date.parse(result.ts),
      result: result.status,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      value: result.value,
      unit: result.unit,
      message: result.message,
      host: result.from,
      via: result.via,
    });
  }
}

/** A run's `/start`: until its result, the monitor is running, and the result's run is measured from here. */
export function noteStart(ruleId: string, now: number, db: Database): void {
  db.query("UPDATE alert_rules SET started_at = ? WHERE id = ?").run(now, ruleId);
}

/** "missed: nothing since 10-19T02:04, due 10-20T02:04". */
export function missedWords(rule: AlertRule, dueAt: number): string {
  return `missed: no result since ${iso(rule.due_from ?? rule.created_at)}, due ${iso(dueAt)}`;
}

/**
 * One pass of a push monitor (#177). Past its `every` with nothing in it is late, which shows
 * and calls nobody; past `every` + `grace` it opens. Then its calls, as any monitor's.
 */
export async function passPushMonitor(ruleId: string, now: number, deps: CallDeps): Promise<void> {
  const db = deps.db;
  // Read now, not when the pass began: a result may have come in while it called another.
  let rule = getAlert(ruleId, db);
  if (!rule || rule.source !== "push") {
    return;
  }
  const opensAt = pushOpensAt(rule);
  if (rule.enabled !== 0 && rule.state !== "open" && opensAt !== null && now >= opensAt) {
    const due = pushDueAt(rule)!;
    beginStretch(rule.id, now, { value: null, count: null, message: missedWords(rule, due) }, db, due);
    rule = getAlert(ruleId, db)!;
  }
  const current = rule;
  await passCalls(
    current,
    now,
    {
      windowMs: current.every_ms ?? fallbackWindowMs,
      sendsResolved: sendsResolved(current),
      payload: (what, stretch, url) => pushCallPayload(current, { what, stretch, now, url }, deps),
    },
    deps,
  );
}

/** A push monitor's Search: its `monitor:` query, from a little before the stretch to now. */
function pushLink(rule: AlertRule, stretch: MonitorStretch, now: number, base: string | null): string | null {
  if (!base) {
    return null;
  }
  const pad = Math.max(60 * 60_000, 3 * (rule.every_ms ?? 0));
  return alertLink(base, {
    savedId: null,
    query: rule.query,
    agg: null,
    from: iso(Math.min(stretch.due_at ?? stretch.opened_at, stretch.opened_at) - pad),
    to: iso(now),
  });
}

function pushCallPayload(
  rule: AlertRule,
  input: { what: Exclude<CallWhat, "sent">; stretch: MonitorStretch; now: number; url: string },
  deps: CallDeps,
): WebhookPayload {
  const { what, stretch, now } = input;
  const call = {
    state: what,
    openedAt: iso(stretch.opened_at),
    resolvedAt: stretch.resolved_at !== null ? iso(stretch.resolved_at) : null,
    duration: formatOpenFor((stretch.resolved_at ?? now) - stretch.opened_at),
  };
  const link = pushLink(rule, stretch, now, deps.publicUrl());
  const value = what === "open" ? stretch.open_value : stretch.last_value;
  const firedAt = iso(now);
  const defaultBody = pushWebhookBody({
    url: input.url,
    alert: { id: rule.id, name: rule.name },
    query: rule.query,
    message: stretch.open_message,
    value,
    firedAt,
    link,
    call,
  });
  const values = pushFillValues({
    name: rule.name,
    value,
    query: rule.query,
    firedAt,
    link,
    call,
    message: stretch.open_message,
  });
  return what === "resolved" ? renderResolved(rule, defaultBody, values)! : renderWebhook(rule, defaultBody, values);
}
