import type { Context } from "hono";
import type { ChangeMark } from "../shared/change-mark";
import {
  compareFoldKind,
  compareFoldNote,
  compareFoldPercent,
  compareFoldShowDelta,
  compareFoldSideFromSearch,
  type CompareFoldKind,
  type CompareFoldSide,
} from "../shared/compare-fold";
import { formatFingerprintCutDuration, fingerprintCutWindows } from "../shared/fingerprint-cut";
import { InvalidAggError } from "./agg";
import { QueryCompileError } from "./compile";
import { resolveHunt } from "./fingerprint-cut";
import { getChangeMarkById } from "./marks";
import { InvalidMetricError } from "../shared/metric";
import { InvalidRangeError } from "./relative";
import { search } from "./index";

/**
 * Compare around a mark (#359), as Hunt's Compare fold reads it (ui/components/compare-fold.tsx):
 * the after side runs from the mark to the window's end (or to an incident's end), the before side
 * is as long and ends at the mark, and each side is one exact search with no events. The fold does
 * this in the browser; this is the same reading in one call, for an agent.
 */
export type CompareResult = {
  mark: ChangeMark;
  /** count, rate, numeric (an agg of an attribute) or metric. */
  kind: CompareFoldKind;
  before: CompareFoldSide & { from: string; to: string };
  after: CompareFoldSide & { from: string; to: string };
  side_ms: number;
  /** A closed incident: the sides are the band and the same span before it. */
  banded: boolean;
  /** The window ends before the mark: there is no after to read. */
  dead: boolean;
  /** after − before, when both sides can be numbered. */
  delta: number | null;
  /** The change as a percent of before, when before is above 0. */
  percent: number | null;
  /** What Compare would say under the numbers, or empty. */
  note: string;
  /** A side was refused by the scan budget: why. */
  refused?: string;
};

export async function compareAroundMark(input: {
  mark: ChangeMark;
  from?: string;
  to?: string;
  range?: string;
  q?: string;
  agg?: string;
  metric?: string;
  ml?: string;
  now?: number;
}): Promise<CompareResult> {
  const now = input.now ?? Date.now();
  const hunt = input.range || (input.from && input.to)
    ? resolveHunt(input.from, input.to, input.range)
    : { from: input.from ?? input.mark.ts, to: input.to ?? new Date(now).toISOString() };
  const w = fingerprintCutWindows({
    markTs: Date.parse(input.mark.ts),
    markEndTs: input.mark.end_ts ? Date.parse(input.mark.end_ts) : null,
    kind: input.mark.kind,
    huntFrom: Date.parse(hunt.from),
    huntTo: Date.parse(hunt.to),
    openedAt: Math.min(now, Date.parse(hunt.to)),
  });
  const kind = compareFoldKind(input.agg ?? null, input.metric ?? null);
  const iso = (ms: number) => new Date(ms).toISOString();
  const empty: CompareFoldSide = { v: null, n: 0, empty: true, refused: false };
  const side = async (fromMs: number, toMs: number) =>
    search({
      from: iso(fromMs),
      to: iso(toMs),
      q: input.q,
      events: "0",
      split: "none",
      exact: true,
      ...(input.metric ? { metric: input.metric, ml: input.ml } : input.agg ? { agg: input.agg } : {}),
    });
  const [beforeJson, afterJson] = w.dead
    ? [null, null]
    : await Promise.all([side(w.beforeFrom, w.beforeTo), side(w.afterFrom, w.afterTo)]);
  const before = beforeJson ? compareFoldSideFromSearch(beforeJson, kind) : empty;
  const after = afterJson ? compareFoldSideFromSearch(afterJson, kind) : empty;
  const refused = [beforeJson, afterJson]
    .map((j) => (j?.scan?.source === "refused" ? j.scan.reason : j?.agg?.source === "refused" ? (j.agg.reason ?? "") : ""))
    .find((reason) => reason !== "");
  const show = compareFoldShowDelta(w, kind, before, after);
  return {
    mark: input.mark,
    kind,
    before: { ...before, from: iso(w.beforeFrom), to: iso(w.beforeTo) },
    after: { ...after, from: iso(w.afterFrom), to: iso(w.afterTo) },
    side_ms: w.sideMs,
    banded: w.banded,
    dead: w.dead,
    delta: show ? (after.v ?? 0) - (before.v ?? 0) : null,
    percent: show && !before.empty ? compareFoldPercent(before.v ?? 0, after.v ?? 0) : null,
    note: compareFoldNote({ windows: w, kind, before, after, formatDuration: formatFingerprintCutDuration }),
    ...(refused ? { refused } : {}),
  };
}

/** `GET /api/search/compare?mark=` — a query's count, rate, agg or metric before and after a change mark. */
export async function compareRoute(c: Context): Promise<Response> {
  const markId = c.req.query("mark")?.trim() ?? "";
  if (!markId) {
    return c.json({ error: "mark is required" }, 400);
  }
  try {
    const mark = await getChangeMarkById(markId);
    if (!mark) {
      return c.json({ error: "mark not found" }, 404);
    }
    return c.json(
      await compareAroundMark({
        mark,
        from: c.req.query("from") ?? undefined,
        to: c.req.query("to") ?? undefined,
        range: c.req.query("range") ?? undefined,
        q: c.req.query("q") ?? undefined,
        agg: c.req.query("agg") || undefined,
        metric: c.req.query("metric") || undefined,
        ml: c.req.query("ml") ?? undefined,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidRangeError || err instanceof InvalidAggError || err instanceof InvalidMetricError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof QueryCompileError) {
      return c.json({ error: err.message, faults: err.faults }, 400);
    }
    throw err;
  }
}
