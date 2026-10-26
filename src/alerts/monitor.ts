import type { Database } from "bun:sqlite";
import type { AlertRule } from "../control/alerts";
import type { SavedSearch } from "../control/saved-searches";
import { parseRangeMs } from "../query/relative";
import { type MonitorMeasure,
  callRetryMs,
  fewerThanProblem,
  formatOpenFor,
  remindEveryMs,
  type CantTell,
  type MonitorResult,
  type OpensWhen,
} from "../shared/monitor";
import type { WebhookOutcome } from "./delivery";
import {
  beginStretch,
  noteReading,
  openStretch,
  pendingResolved,
  recordCall,
  recordResult,
  resolveStretch,
  setCalledAt,
  setCantTell,
  setOpenCall,
  setResolvedCall,
  type CallWhat,
  type MonitorStretch,
  type Reading,
} from "./monitor-store";
import {
  alertLink,
  alertWebhookBody,
  readingMessage,
  renderResolved,
  renderWebhook,
  sendsResolved,
  thresholdFillValues,
  type CallState,
  type WebhookPayload,
} from "./payload";
import type { AlertSeries } from "./series";

/** A saved search with no relative range (a fixed from/to) is read every pass and reminds every 5m. */
export const fallbackWindowMs = 5 * 60 * 1000;

/** What a monitor's calls go through. */
export type CallDeps = {
  db: Database;
  post: (url: string, payload: WebhookPayload) => Promise<WebhookOutcome>;
  publicUrl: () => string | null;
  recordWebhook: (id: string, attempt: WebhookOutcome & { at: number }, db: Database) => void;
  /** The webhook from Settings, for a monitor without its own (#177). */
  defaultWebhook?: () => string | null;
  /** A call went through. */
  onSent?: () => void;
};

export type SearchMonitorDeps = CallDeps & {
  /** The saved search's series, or with `share` its share of all rows (#279). */
  read: (saved: SavedSearch, measure?: MonitorMeasure) => Promise<AlertSeries>;
  recordEval: (
    id: string,
    stamp: { at: number; status: "refused" | "error" | "ok"; error: string | null },
    db: Database,
  ) => void;
  /**
   * Why a fewer-than reading may not mean it (#176): Toposcope not up for one whole window, or a
   * linked source short inside it. Without it, every reading can tell.
   */
  cantTell?: (saved: SavedSearch, windowMs: number, now: number) => CantTell | null;
};

/** Where a monitor's calls go: its own webhook, else the default from Settings, else nowhere. */
export function callUrl(rule: Pick<AlertRule, "webhook_url"> & { webhook_urls?: string[] | null }, deps: Pick<CallDeps, "defaultWebhook">): string | null {
  return callUrls(rule, deps)[0] ?? null;
}

/** The most delivery targets one monitor has (#280). */
export const maxCallTargets = 5;

/**
 * Every place a monitor's calls go (#280): its targets, each a URL or `default` (the webhook in
 * Settings, followed when it changes); without a list, its own webhook, else the default.
 */
export function callUrls(rule: Pick<AlertRule, "webhook_url"> & { webhook_urls?: string[] | null }, deps: Pick<CallDeps, "defaultWebhook">): string[] {
  const listed = rule.webhook_urls && rule.webhook_urls.length ? rule.webhook_urls : [rule.webhook_url || "default"];
  const out: string[] = [];
  for (const t of listed) {
    const url = t === "default" ? (deps.defaultWebhook?.() ?? null) : t;
    if (url && !out.includes(url)) {
      out.push(url);
    }
  }
  return out.slice(0, maxCallTargets);
}

export function searchWindowMs(saved: Pick<SavedSearch, "range">): number {
  return saved.range ? (parseRangeMs(saved.range) ?? fallbackWindowMs) : fallbackWindowMs;
}

/** At least the threshold opens a loud search; fewer than it, a quiet one (#176). */
export function readsFail(opensWhen: OpensWhen, value: number, threshold: number): boolean {
  return opensWhen === "fewer_than" ? value < threshold : value >= threshold;
}

/** A fail opens it; the first ok after that resolves it; a warn shows and changes nothing. */
export function nextMove(
  state: "ok" | "open",
  result: MonitorResult | null,
): "open" | "resolve" | "still-open" | "none" {
  if (result === "fail") {
    return state === "open" ? "still-open" : "open";
  }
  if (result === "ok" && state === "open") {
    return "resolve";
  }
  return "none";
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One pass of a saved-search monitor (#175). Its series is read; at or above the threshold is a
 * fail, below it an ok (the other way round for fewer than, #176), and a refused or failed
 * reading is no result, which changes nothing. A fewer-than reading below the threshold is no
 * result either while it can't tell: until Toposcope has been up one whole window, or while a
 * linked source that could feed the count is short inside it. Then its calls: the open call
 * (tried each pass for up to an hour), a reminder when one is due, and a resolved call for each stretch that has resolved since. While silenced nothing is sent,
 * but the stretches are kept, and no call is made up for when the silence ends.
 */
export async function passSearchMonitor(
  rule: AlertRule,
  saved: SavedSearch,
  now: number,
  deps: SearchMonitorDeps,
): Promise<void> {
  const db = deps.db;
  const fewer = rule.opens_when === "fewer_than";
  const windowMs = searchWindowMs(saved);
  let reading: Reading | null = null;
  let expr: string | null = saved.agg;
  // The saved search may have changed under it: a p99 or a fixed from/to cannot read fewer than.
  const problem = fewer && (rule.measure ?? "series") === "series" ? fewerThanProblem(saved) : null;
  try {
    const series = problem
      ? { expr: saved.agg, count: 0, value: 0, refused: true, reason: problem }
      : await deps.read(saved, rule.measure ?? "series");
    expr = series.expr;
    if (series.refused) {
      deps.recordEval(rule.id, { at: now, status: "refused", error: series.reason ?? "refused" }, db);
      console.warn(`monitor ${rule.id} can't tell: ${series.reason ?? "refused"}`);
    } else {
      deps.recordEval(rule.id, { at: now, status: "ok", error: null }, db);
      reading = {
        value: series.value,
        count: series.count,
        message: readingMessage(series.expr, series.value, rule.threshold, rule.opens_when, saved.range),
      };
    }
  } catch (err) {
    console.error("monitor reading failed", err);
    deps.recordEval(
      rule.id,
      { at: now, status: "error", error: err instanceof Error ? err.message : String(err) },
      db,
    );
  }

  let cantTell: CantTell | null = null;
  if (reading) {
    let result: MonitorResult | null = readsFail(rule.opens_when, reading.value ?? 0, rule.threshold) ? "fail" : "ok";
    // Too few lines can mean the lines are not here yet: it stays as it is until it can tell.
    if (fewer && result === "fail") {
      cantTell = deps.cantTell?.(saved, windowMs, now) ?? null;
      if (cantTell) {
        result = null;
        console.warn(`monitor ${rule.id} can't tell: ${cantTell.kind}`);
      }
    }
    if (result) {
      recordMove(rule.id, result, reading, now, db);
    }
  }
  if (cantTell || rule.cant_tell) {
    setCantTell(rule.id, cantTell, db);
  }

  // Read whether or not anybody is called: its state is kept either way (#177).
  await passCalls(
    rule,
    now,
    {
      windowMs,
      sendsResolved: sendsResolved(rule),
      payload: (what, stretch, url) => searchCallPayload(rule, saved, { what, stretch, reading, expr, now, url }, deps),
    },
    deps,
  );
}

/**
 * A monitor's calls on one pass (#175): the open call (tried each pass for up to an hour), a
 * reminder when one is due, and a resolved call for each stretch that has resolved since. While
 * silenced nothing is sent, but the calls kept back are recorded, and none is made up when the
 * silence ends. With no webhook of its own and none in Settings, it calls nobody: its stretches
 * say so (`none`), and its state is kept all the same.
 */
export async function passCalls(
  rule: AlertRule,
  now: number,
  plan: {
    /** A reminder every `window` is once per this. */
    windowMs: number;
    sendsResolved: boolean;
    payload: (what: Exclude<CallWhat, "sent">, stretch: MonitorStretch, url: string) => WebhookPayload;
  },
  deps: CallDeps,
): Promise<void> {
  const db = deps.db;
  const urls = callUrls(rule, deps);
  const url = urls[0] ?? null;
  const silenced = rule.silenced_until != null && now < rule.silenced_until;
  /** One call to every target (#280): each its own record; taken when at least one target took it. */
  const send = async (what: Exclude<CallWhat, "sent">, stretch: MonitorStretch): Promise<WebhookOutcome> => {
    let first: WebhookOutcome | null = null;
    let taken: WebhookOutcome | null = null;
    for (const target of urls) {
      const outcome = await deps.post(target, plan.payload(what, stretch, target));
      deps.recordWebhook(rule.id, { at: now, ...outcome }, db);
      recordCall(
        {
          monitor_id: rule.id,
          stretch_id: stretch.id,
          at: now,
          what,
          status: outcome.status,
          ok: outcome.ok,
          error: outcome.error,
        },
        db,
      );
      first ??= outcome;
      if (outcome.ok) {
        taken ??= outcome;
      }
    }
    if (taken) {
      deps.onSent?.();
    }
    return taken ?? first!;
  };
  const keptBack = (what: CallWhat, stretch: MonitorStretch) =>
    recordCall(
      { monitor_id: rule.id, stretch_id: stretch.id, at: now, what, status: "silenced", ok: false, error: null },
      db,
    );

  const stretch = openStretch(rule.id, db);
  if (stretch) {
    if (stretch.open_call === null) {
      if (!url) {
        setOpenCall(stretch.id, "none", now, db);
      } else if (silenced) {
        setOpenCall(stretch.id, "silenced", now, db);
        keptBack("open", stretch);
      } else if (now - stretch.opened_at >= callRetryMs) {
        setOpenCall(stretch.id, "failed", now, db);
      } else if ((await send("open", stretch)).ok) {
        setOpenCall(stretch.id, "sent", now, db);
      }
    } else if (url) {
      const every = remindEveryMs(rule.remind_every, plan.windowMs);
      if (every !== null && now - (stretch.called_at ?? stretch.opened_at) >= every) {
        if (silenced) {
          setCalledAt(stretch.id, now, db);
          keptBack("reminder", stretch);
        } else if ((await send("reminder", stretch)).ok) {
          setCalledAt(stretch.id, now, db);
        }
      }
    }
  }

  for (const done of pendingResolved(rule.id, db)) {
    if (!plan.sendsResolved || !url) {
      setResolvedCall(done.id, "none", db);
    } else if (silenced) {
      setResolvedCall(done.id, "silenced", db);
      keptBack("resolved", done);
    } else if (now - (done.resolved_at ?? now) >= callRetryMs) {
      setResolvedCall(done.id, "failed", db);
    } else if ((await send("resolved", done)).ok) {
      setResolvedCall(done.id, "sent", db);
    }
  }
}

/** A result: kept on the monitor, and it opens, keeps open or resolves a stretch. */
function recordMove(id: string, result: MonitorResult, reading: Reading, now: number, db: Database): void {
  recordResult(id, result, reading.value, now, db);
  const open = openStretch(id, db);
  switch (nextMove(open ? "open" : "ok", result)) {
    case "open":
      beginStretch(id, now, reading, db);
      break;
    case "still-open":
      noteReading(open!.id, now, reading, db);
      break;
    case "resolve":
      resolveStretch(id, open!.id, now, reading, db);
      break;
    default:
      break;
  }
}

/** One search monitor call for a stretch, as it goes on the wire. */
function searchCallPayload(
  rule: AlertRule,
  saved: SavedSearch,
  input: {
    what: Exclude<CallWhat, "sent">;
    stretch: MonitorStretch;
    reading: Reading | null;
    expr: string | null;
    now: number;
    url: string;
  },
  deps: CallDeps,
): WebhookPayload {
  const { what, stretch, now } = input;
  const state: CallState = what;
  // The open call says what opened it; a reminder or a resolved call says what it reads now.
  const value =
    what === "open"
      ? (stretch.open_value ?? 0)
      : (input.reading?.value ?? stretch.last_value ?? 0);
  const count =
    what === "open"
      ? (stretch.open_count ?? 0)
      : (input.reading?.count ?? stretch.last_count ?? 0);
  const firedAt = iso(now);
  const endMs = stretch.resolved_at ?? now;
  const call = {
    state,
    openedAt: iso(stretch.opened_at),
    resolvedAt: stretch.resolved_at !== null ? iso(stretch.resolved_at) : null,
    duration: formatOpenFor(endMs - stretch.opened_at),
  };
  const base = deps.publicUrl();
  const rangeMs = saved.range ? parseRangeMs(saved.range) : null;
  // The window that opened it; a reminder or resolved call reaches back to before it opened.
  const fromMs = rangeMs !== null ? (what === "open" ? now : stretch.opened_at) - rangeMs : null;
  const from = fromMs !== null ? iso(fromMs) : saved.from_ts;
  const to = rangeMs !== null ? firedAt : saved.to_ts;
  const link =
    base && from && to
      ? alertLink(base, { savedId: saved.id, query: saved.query, agg: saved.agg, from, to })
      : null;
  const defaultBody = alertWebhookBody({
    url: input.url,
    alert: {
      id: rule.id,
      name: rule.name,
      threshold: rule.threshold,
      ...(rule.opens_when === "fewer_than" ? { opens_when: rule.opens_when } : {}),
    },
    count,
    value,
    agg: input.expr,
    query: saved.query,
    firedAt,
    link,
    call,
  });
  const values = thresholdFillValues({
    name: rule.name,
    agg: input.expr,
    value,
    threshold: rule.threshold,
    query: saved.query,
    firedAt,
    link,
    call,
    message: stretch.open_message,
  });
  return what === "resolved" ? renderResolved(rule, defaultBody, values)! : renderWebhook(rule, defaultBody, values);
}
