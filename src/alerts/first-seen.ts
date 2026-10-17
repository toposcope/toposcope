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
import { alertLink, firstSeenWebhookBody } from "./payload";

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
  post: (url: string, body: unknown) => Promise<WebhookOutcome>;
  publicUrl: () => string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

function hm(isoTs: string): string {
  return isoTs.slice(11, 16);
}

type MarkCut = {
  mark: ChangeMark;
  cut: Awaited<ReturnType<FirstSeenDeps["cut"]>>;
  /** First seen after this mark, with at least `threshold` events, not yet sent for it. */
  fresh: FingerprintCutSideCount[];
};

/**
 * A fingerprint new after several marks pages once: for the latest of them at or before its
 * first event, the mark the Fingerprints panel names ("after v0.9.3"). Its first event is read
 * after the earliest of them; when that read gives nothing, the latest mark it is new after.
 */
async function ownerMarks(
  cuts: MarkCut[],
  compiled: CompiledQuery,
  deps: FirstSeenDeps,
): Promise<{ owner: Map<string, MarkCut>; marksOf: Map<string, MarkCut[]> }> {
  const marksOf = new Map<string, MarkCut[]>();
  for (const item of cuts) {
    for (const row of item.fresh) {
      marksOf.set(row.hex, [...(marksOf.get(row.hex) ?? []), item]);
    }
  }
  const owner = new Map<string, MarkCut>();
  const byEarliest = new Map<MarkCut, string[]>();
  for (const [hex, items] of marksOf) {
    if (items.length === 1) {
      owner.set(hex, items[0]!);
    } else {
      byEarliest.set(items[0]!, [...(byEarliest.get(items[0]!) ?? []), hex]);
    }
  }
  for (const [earliest, hexes] of byEarliest) {
    const details = await deps.details(earliest.cut.windows, compiled, hexes);
    for (const hex of hexes) {
      const items = marksOf.get(hex)!;
      const firstTs = details.get(hex)?.firstTs;
      const at = firstTs ? Date.parse(firstTs) : Number.NaN;
      const atOrBefore = Number.isNaN(at)
        ? []
        : items.filter((item) => Date.parse(item.mark.ts) <= at);
      owner.set(hex, atOrBefore.at(-1) ?? items.at(-1)!);
    }
  }
  return { owner, marksOf };
}

/**
 * One minute of a first-seen alert: for every deploy or flag mark of the last 24 hours that the
 * saved search's `q` does not rule out, the First seen set the Fingerprints panel would show,
 * cut at now. Fingerprints with at least `threshold` events after the mark that this rule has not
 * sent go in one call per mark, each fingerprint under one mark only (`ownerMarks`). Sent only on
 * a 2xx, and then for every mark it was new after, so a failed call is tried again the next
 * minute and a sent one is never paged under another mark.
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
  const marks = (await deps.marks(iso(now - firstSeenWatchMs), iso(now))).filter(
    (mark) =>
      firstSeenMarkKinds.has(mark.kind) &&
      Date.parse(mark.ts) <= now &&
      !queryRulesOutService(compiled.ast, mark.service),
  );
  marks.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
  let refusal: string | null = null;
  let attempted = false;
  const cuts: MarkCut[] = [];
  for (const mark of marks) {
    const cut = await deps.cut({ mark, compiled, now });
    if (cut.refused) {
      refusal = `${cut.refused} after ${formatChangeMarkLabel(mark)} · ${hm(mark.ts)}`;
      continue;
    }
    const sent = deps.sent(rule.id, mark.id);
    const fresh = cut.firstSeen.filter(
      (row) => row.after >= rule.threshold && !sent.has(row.hex),
    );
    if (fresh.length > 0) {
      cuts.push({ mark, cut, fresh });
    }
  }
  const { owner, marksOf } = await ownerMarks(cuts, compiled, deps);
  for (const { mark, cut, fresh: candidates } of cuts) {
    const fresh = candidates
      .filter((row) => owner.get(row.hex)?.mark.id === mark.id)
      .sort((a, b) => b.after - a.after || a.hex.localeCompare(b.hex));
    if (fresh.length === 0) {
      continue;
    }
    const listed = fresh.slice(0, firstSeenListCap);
    const details = await deps.details(
      cut.windows,
      compiled,
      listed.map((row) => row.hex),
    );
    const firedAt = iso(now);
    const base = deps.publicUrl();
    const link = base
      ? alertLink(base, {
          savedId: saved.id,
          query: saved.query,
          agg: null,
          from: iso(cut.windows.beforeFrom),
          to: firedAt,
          cut: mark.id,
        })
      : null;
    attempted = true;
    const outcome = await deps.post(
      rule.webhook_url,
      firstSeenWebhookBody({
        url: rule.webhook_url,
        alert: { id: rule.id, name: rule.name, threshold: rule.threshold },
        query: saved.query,
        mark: {
          id: mark.id,
          kind: mark.kind,
          service: mark.service,
          title: mark.title,
          ts: mark.ts,
        },
        fingerprints: listed.map((row) => {
          const detail = details.get(row.hex);
          return {
            e1: row.hex,
            type: detail?.type ?? "",
            message: detail?.message ?? "",
            first_seen: detail?.firstTs ?? null,
            events: row.after,
          };
        }),
        more: fresh.length - listed.length,
        firedAt,
        link,
      }),
    );
    deps.recordWebhook(rule.id, { at: now, ...outcome });
    if (outcome.ok) {
      // Sent for every mark each fingerprint was new after, so no other mark pages it.
      const sentFor = new Map<string, string[]>();
      for (const row of fresh) {
        for (const item of marksOf.get(row.hex) ?? []) {
          sentFor.set(item.mark.id, [...(sentFor.get(item.mark.id) ?? []), row.hex]);
        }
      }
      for (const [markId, e1s] of sentFor) {
        deps.recordSent(rule.id, markId, e1s, now);
      }
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
