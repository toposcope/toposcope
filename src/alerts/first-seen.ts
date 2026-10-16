import {
  recordEvalAttempt,
  recordLastMark,
  recordSentFingerprints,
  recordWebhookAttempt,
  sentFingerprints,
  type AlertLastMark,
  type AlertRule,
} from "../control/alerts";
import type { SavedSearch } from "../control/saved-searches";
import { incMetric } from "../metrics";
import { compileQuery, type CompiledQuery, type QueryNode } from "../query/compile";
import {
  fingerprintCutFirstSeen,
  firstSeenDetails,
  type FirstSeenDetail,
} from "../query/fingerprint-cut";
import { changeMarksBetween } from "../query/marks";
import { formatChangeMarkLabel, type ChangeMark } from "../shared/change-mark";
import type { FingerprintCutSideCount, FingerprintCutWindows } from "../shared/fingerprint-cut";
import { publicUrl } from "../shared/public-url";
import type { WebhookOutcome } from "./delivery";
import {
  alertLink,
  firstSeenFillValues,
  firstSeenWebhookBody,
  renderWebhook,
  type FirstSeenFingerprint,
  type FirstSeenMark,
  type WebhookPayload,
} from "./payload";

/** Each deploy or flag mark is watched this long. */
export const firstSeenWatchMs = 24 * 60 * 60_000;

/** The marks that change behavior; an incident is a consequence, a note changes nothing. */
export const firstSeenMarkKinds = new Set<ChangeMark["kind"]>(["deploy", "flag"]);

/** Fingerprints listed in one call; the rest are counted. */
export const firstSeenListCap = 10;

type Tri = true | false | null;

/**
 * Whether `q` rules a mark out by its service, by a plain mismatch: `q` read with only its
 * `service:` terms known, and everything else possibly true. A mark with no service is never
 * ruled out.
 */
export function queryRulesOutService(node: QueryNode | null, service: string): boolean {
  if (!service.trim()) {
    return false;
  }
  return evalService(node, service) === false;
}

function evalService(node: QueryNode | null, service: string): Tri {
  if (!node) {
    return true;
  }
  switch (node.op) {
    case "kv":
      if (node.key !== "service") {
        return null;
      }
      return node.glob ? service.startsWith(node.value) : service === node.value;
    case "and": {
      const a = evalService(node.a, service);
      const b = evalService(node.b, service);
      if (a === false || b === false) return false;
      if (a === true && b === true) return true;
      return null;
    }
    case "or": {
      const a = evalService(node.a, service);
      const b = evalService(node.b, service);
      if (a === true || b === true) return true;
      if (a === false && b === false) return false;
      return null;
    }
    case "not": {
      const a = evalService(node.a, service);
      return a === null ? null : !a;
    }
    default:
      return null;
  }
}

export type FirstSeenDeps = {
  marks: (fromIso: string, toIso: string) => Promise<ChangeMark[]>;
  cut: (input: { mark: ChangeMark; compiled: CompiledQuery; now: number }) => Promise<{
    windows: FingerprintCutWindows;
    firstSeen: FingerprintCutSideCount[];
    refused: string | null;
  }>;
  details: (
    windows: FingerprintCutWindows,
    compiled: CompiledQuery,
    hexes: string[],
  ) => Promise<Map<string, FirstSeenDetail>>;
  sent: (ruleId: string, markId: string) => Set<string>;
  recordSent: (ruleId: string, markId: string, e1s: string[], at: number) => void;
  recordLastMark: (ruleId: string, mark: AlertLastMark) => void;
  recordWebhook: (ruleId: string, attempt: WebhookOutcome & { at: number }) => void;
  recordEval: (
    ruleId: string,
    stamp: { at: number; status: "refused" | "error" | "ok"; error: string | null },
  ) => void;
  post: (url: string, payload: WebhookPayload) => Promise<WebhookOutcome>;
  publicUrl: () => string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

function hm(isoTs: string): string {
  return isoTs.slice(11, 16);
}

/**
 * One minute of a first-seen alert: for every deploy or flag mark of the last 24 hours that the
 * saved search's `q` does not rule out, the First seen set the Fingerprints panel would show,
 * cut at now. Fingerprints with at least `threshold` events after the mark that this rule has not
 * sent for that mark go in one call per mark. Sent only on a 2xx, so a failed call is tried
 * again the next minute.
 */
export async function evaluateFirstSeenRule(
  rule: AlertRule,
  saved: SavedSearch,
  now: number,
  deps: FirstSeenDeps,
): Promise<void> {
  if (!rule.webhook_url) {
    return;
  }
  if (rule.silenced_until != null && now < rule.silenced_until) {
    deps.recordEval(rule.id, { at: now, status: "ok", error: null });
    return;
  }
  const compiled = compileQuery(saved.query ?? "");
  if (compiled.faults.length > 0) {
    deps.recordEval(rule.id, {
      at: now,
      status: "error",
      error: compiled.faults[0]?.msg ?? "the saved search's q does not compile",
    });
    return;
  }
  const marks = watchedMarks(await deps.marks(iso(now - firstSeenWatchMs), iso(now)), compiled, now);
  let refusal: string | null = null;
  let attempted = false;
  for (const mark of marks) {
    const cut = await deps.cut({ mark, compiled, now });
    if (cut.refused) {
      refusal = `${cut.refused} after ${formatChangeMarkLabel(mark)} · ${hm(mark.ts)}`;
      continue;
    }
    const sent = deps.sent(rule.id, mark.id);
    const fresh = cut.firstSeen
      .filter((row) => row.after >= rule.threshold && !sent.has(row.hex))
      .sort((a, b) => b.after - a.after || a.hex.localeCompare(b.hex));
    if (fresh.length === 0) {
      continue;
    }
    attempted = true;
    const payload = await firstSeenPayload({
      rule: { ...rule, webhook_url: rule.webhook_url },
      saved,
      mark,
      windows: cut.windows,
      fresh,
      compiled,
      now,
      deps,
    });
    const outcome = await deps.post(rule.webhook_url, payload);
    deps.recordWebhook(rule.id, { at: now, ...outcome });
    if (outcome.ok) {
      deps.recordSent(
        rule.id,
        mark.id,
        fresh.map((row) => row.hex),
        now,
      );
      deps.recordLastMark(rule.id, {
        id: mark.id,
        kind: mark.kind,
        title: mark.title,
        service: mark.service,
        ts: mark.ts,
        count: fresh.length,
        at: now,
      });
      incMetric("alert_fires");
    }
  }
  if (refusal) {
    deps.recordEval(rule.id, { at: now, status: "refused", error: refusal });
  } else if (!attempted) {
    deps.recordEval(rule.id, { at: now, status: "ok", error: null });
  }
}

/** Deploy and flag marks, up to now, whose service the q does not rule out. */
export function watchedMarks(marks: ChangeMark[], compiled: CompiledQuery, now: number): ChangeMark[] {
  return marks.filter(
    (mark) =>
      firstSeenMarkKinds.has(mark.kind) &&
      Date.parse(mark.ts) <= now &&
      !queryRulesOutService(compiled.ast, mark.service),
  );
}

/** One mark's call: ten fingerprints listed, the rest counted, in the alert's body. */
export async function firstSeenPayload(input: {
  rule: Pick<AlertRule, "id" | "name" | "threshold" | "body_kind" | "body_template"> & { webhook_url: string };
  saved: Pick<SavedSearch, "id" | "query">;
  mark: ChangeMark;
  windows: FingerprintCutWindows;
  fresh: FingerprintCutSideCount[];
  compiled: CompiledQuery;
  now: number;
  deps: Pick<FirstSeenDeps, "details" | "publicUrl">;
}): Promise<WebhookPayload> {
  const { rule, saved, mark, windows, fresh, now } = input;
  const listed = fresh.slice(0, firstSeenListCap);
  const details = await input.deps.details(
    windows,
    input.compiled,
    listed.map((row) => row.hex),
  );
  const firedAt = iso(now);
  const base = input.deps.publicUrl();
  const link = base
    ? alertLink(base, {
        savedId: saved.id,
        query: saved.query,
        agg: null,
        from: iso(windows.beforeFrom),
        to: firedAt,
        cut: mark.id,
      })
    : null;
  const markOut: FirstSeenMark = {
    id: mark.id,
    kind: mark.kind,
    service: mark.service,
    title: mark.title,
    ts: mark.ts,
  };
  const fingerprints: FirstSeenFingerprint[] = listed.map((row) => {
    const detail = details.get(row.hex);
    return {
      e1: row.hex,
      type: detail?.type ?? "",
      message: detail?.message ?? "",
      first_seen: detail?.firstTs ?? null,
      events: row.after,
    };
  });
  const more = fresh.length - listed.length;
  return renderWebhook(
    rule,
    firstSeenWebhookBody({
      url: rule.webhook_url,
      alert: { id: rule.id, name: rule.name, threshold: rule.threshold },
      query: saved.query,
      mark: markOut,
      fingerprints,
      more,
      firedAt,
      link,
    }),
    firstSeenFillValues({ name: rule.name, query: saved.query, mark: markOut, fingerprints, more, link }),
  );
}

export function firstSeenDeps(post: FirstSeenDeps["post"]): FirstSeenDeps {
  return {
    marks: changeMarksBetween,
    cut: fingerprintCutFirstSeen,
    details: firstSeenDetails,
    sent: sentFingerprints,
    recordSent: recordSentFingerprints,
    recordLastMark,
    recordWebhook: recordWebhookAttempt,
    recordEval: recordEvalAttempt,
    post,
    publicUrl,
  };
}
