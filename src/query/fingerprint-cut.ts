import type { Context } from "hono";
import { activeLinks } from "../links/store";
import { feeders, heldSources, shortIn, type HeldLink } from "../shared/held";
import {
  formatChangeMarkLabel,
  type ChangeMark,
} from "../shared/change-mark";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { fingerprintAttr } from "../shared/fingerprint";
import {
  capFingerprintCutSet,
  classifyFingerprintCut,
  fingerprintCutFollows,
  fingerprintCutInsideCap,
  fingerprintCutInsideNotes,
  fingerprintCutMinBeforeMs,
  fingerprintCutNotes,
  fingerprintCutScanCap,
  fingerprintCutWindows,
  formatFingerprintCutDuration,
  mergeFingerprintCutSides,
  nearestInsideMarks,
  type FingerprintCutInsideMark,
  type FingerprintCutResult,
  type FingerprintCutRow,
  type FingerprintCutSet,
  type FingerprintCutSideCount,
  type FingerprintCutWindows,
} from "../shared/fingerprint-cut";
import {
  emitQuerySql,
  QueryCompileError,
  requireCompiled,
  type CompiledQuery,
  type QueryNode,
} from "./compile";
import { changeMarksBetween, getChangeMarkById } from "./marks";
import {
  isNumericAggBudgetError,
  logsScanBudgetRefuseReason,
  numericScanSettings,
} from "./agg";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";

type WhereClause = { sql: string; params: Record<string, string> };

type CountRow = { v: string; n: string | number };

type SampleSqlRow = {
  hex: string;
  sample_message: string;
  sample_service: string;
  sample_level: string;
  first_after: string | null;
};

type Sample = {
  hex: string;
  message: string;
  service: string;
  level: string;
  first_after: string | null;
};

export type { FingerprintCutResult, FingerprintCutRow, FingerprintCutSet };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sampleFirstAfter(
  raw: string | null | undefined,
  afterFromIso: string,
): string | null {
  if (!raw) {
    return null;
  }
  try {
    const value = toIsoTimestamp(String(raw));
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || ms < Date.parse(afterFromIso)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function rowN(n: string | number): number {
  return typeof n === "number" ? n : Number(n);
}

function resolveHunt(
  from: string | undefined,
  to: string | undefined,
  range: string | undefined,
): { from: string; to: string } {
  if (range) {
    const window = resolveRange(range);
    if (!window) {
      throw new InvalidRangeError(range);
    }
    const clamped = clampSearchSpan(window.from, window.to);
    return { from: clamped.from ?? window.from, to: clamped.to ?? window.to };
  }
  if (!from || !to) {
    throw new InvalidRangeError("from/to or range");
  }
  const clamped = clampSearchSpan(from, to);
  return { from: clamped.from ?? from, to: clamped.to ?? to };
}

function parseOpened(raw: string | undefined, huntTo: string): number {
  if (!raw) {
    return Date.parse(huntTo);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidRangeError("opened");
  }
  return ms;
}

function compiledOf(q: string | undefined): CompiledQuery {
  return requireCompiled(q ?? "");
}

function logsWhere(
  fromIso: string,
  toIso: string,
  compiled: CompiledQuery,
): WhereClause {
  const params: Record<string, string> = {
    tenant_id: "default",
    from: fromIso,
    to: toIso,
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "ts >= parseDateTime64BestEffort({from:String})",
    "ts < parseDateTime64BestEffort({to:String})",
  ];
  const sql = emitQuerySql(compiled, params, "logs");
  if (sql) {
    where.push(sql);
  }
  return { sql: where.join(" AND "), params };
}

async function e1Counts(
  fromIso: string,
  toIso: string,
  compiled: CompiledQuery,
): Promise<Array<{ hex: string; n: number }>> {
  const { sql, params } = logsWhere(fromIso, toIso, compiled);
  params.e1key = fingerprintAttr;
  params.limit = String(fingerprintCutScanCap + 1);
  const query = `
    SELECT attr_map[{e1key:String}] AS v, count() AS n
    FROM logs
    WHERE ${sql} AND attr_map[{e1key:String}] != ''
    GROUP BY v
    ORDER BY n DESC, v ASC
    LIMIT {limit:UInt32}
    ${numericScanSettings}
  `;
  const rows = await clickhouseQuery<CountRow>(query, params);
  return rows.map((row) => ({ hex: String(row.v), n: rowN(row.n) }));
}

async function e1Samples(
  fromIso: string,
  toIso: string,
  afterFromIso: string,
  compiled: CompiledQuery,
  hexes: string[],
): Promise<Map<string, Sample>> {
  if (hexes.length === 0) {
    return new Map();
  }
  const { sql, params } = logsWhere(fromIso, toIso, compiled);
  params.e1key = fingerprintAttr;
  params.after_from = afterFromIso;
  const ors: string[] = [];
  hexes.forEach((hex, i) => {
    const key = `h${i}`;
    params[key] = hex;
    ors.push(`attr_map[{e1key:String}] = {${key}:String}`);
  });
  const query = `
    SELECT
      attr_map[{e1key:String}] AS hex,
      any(message) AS sample_message,
      any(service) AS sample_service,
      any(level) AS sample_level,
      minIf(ts, ts >= parseDateTime64BestEffort({after_from:String})) AS first_after
    FROM logs
    WHERE ${sql} AND (${ors.join(" OR ")})
    GROUP BY hex
    ${numericScanSettings}
  `;
  const rows = await clickhouseQuery<SampleSqlRow>(query, params);
  const out = new Map<string, Sample>();
  for (const row of rows) {
    out.set(String(row.hex), {
      hex: String(row.hex),
      message: String(row.sample_message ?? ""),
      service: String(row.sample_service ?? ""),
      level: String(row.sample_level ?? ""),
      first_after: sampleFirstAfter(row.first_after, afterFromIso),
    });
  }
  return out;
}

/** Counts vs samples as replaceable scans so a refused sample cannot wipe the sets. */
export const fingerprintCutScans = {
  counts: e1Counts,
  samples: e1Samples,
};

/** Where each source this instance pulls from stands (#140); tests swap it. */
export const fingerprintCutHeld = {
  links: (): HeldLink[] => activeLinks(),
};

/**
 * The sources that could feed this hunt and are short inside either side of a cut (#140), and
 * which side. A hunt that names other sources is not short (5r). A hole never clears, so a cut
 * whose window touches one keeps refusing.
 */
export function shortAcrossCut(
  ast: QueryNode | null,
  w: Pick<FingerprintCutWindows, "beforeFrom" | "beforeTo" | "afterFrom" | "afterTo">,
  now: number,
): FingerprintCutResult["held"] | null {
  const sources = heldSources(fingerprintCutHeld.links(), now);
  if (sources.length === 0) {
    return null;
  }
  const before = feeders(shortIn(sources, { from: w.beforeFrom, to: w.beforeTo }, now), ast);
  const after = feeders(shortIn(sources, { from: w.afterFrom, to: w.afterTo }, now), ast);
  if (before.length === 0 && after.length === 0) {
    return null;
  }
  const names = new Set([...before, ...after].map((s) => s.name));
  return {
    sides: before.length > 0 && after.length > 0 ? "both" : before.length > 0 ? "before" : "after",
    sources: sources.filter((s) => names.has(s.name)),
  };
}

function hms(isoStr: string): string {
  const t = isoStr.slice(11, 19);
  return t.length === 8 ? t : isoStr;
}

function toRow(
  side: FingerprintCutSideCount,
  sample: Sample | undefined,
  firstSeen: boolean,
  inside: FingerprintCutInsideMark[],
): FingerprintCutRow {
  let extra = "";
  if (firstSeen && sample?.first_after) {
    extra = `first ${hms(sample.first_after)}`;
  }
  return {
    hex: side.hex,
    message: sample?.message ?? "",
    service: sample?.service ?? "",
    level: sample?.level ?? "",
    before: side.before,
    after: side.after,
    extra,
    follows: firstSeen ? fingerprintCutFollows(inside, sample?.first_after ?? null) : "",
  };
}

function packSet(
  id: FingerprintCutSet["id"],
  name: string,
  def: string,
  sides: FingerprintCutSideCount[],
  rank: (row: FingerprintCutSideCount) => number,
  samples: Map<string, Sample>,
  firstSeen: boolean,
  inside: FingerprintCutInsideMark[],
): FingerprintCutSet {
  const capped = capFingerprintCutSet(sides, rank);
  return {
    id,
    name,
    def,
    count: capped.total,
    more: capped.more,
    rows: capped.rows.map((row) =>
      toRow(row, samples.get(row.hex), firstSeen, inside),
    ),
  };
}

/** Stopped is not called while the after side is shorter than the before side. */
function waitingStopped(w: FingerprintCutWindows): FingerprintCutSet {
  return {
    id: "stopped",
    name: "Stopped",
    def: "before the cut, quiet after",
    count: 0,
    more: 0,
    rows: [],
    waiting: { haveMs: w.sideMs, needMs: w.beforeMs },
  };
}

/** `marks` is what the panel names (capped); `all` counts the notes and decides which later mark a row follows. */
type Inside = {
  marks: FingerprintCutInsideMark[];
  more: number;
  all: FingerprintCutInsideMark[];
};

async function insideMarks(
  mark: ChangeMark,
  w: FingerprintCutWindows,
): Promise<Inside> {
  if (w.dead) {
    return { marks: [], more: 0, all: [] };
  }
  const all = (await changeMarksBetween(iso(w.beforeFrom), iso(w.afterTo)))
    .filter((m) => m.id !== mark.id)
    .map((m): FingerprintCutInsideMark => ({
      id: m.id,
      kind: m.kind,
      ts: m.ts,
      label: formatChangeMarkLabel(m),
      title: m.title,
      side: Date.parse(m.ts) < w.afterFrom ? "before" : "after",
    }));
  return {
    marks: nearestInsideMarks(all, w.afterFrom, fingerprintCutInsideCap),
    more: Math.max(0, all.length - fingerprintCutInsideCap),
    all,
  };
}

function windowPayload(w: FingerprintCutWindows, inside: Inside) {
  return {
    afterFrom: iso(w.afterFrom),
    afterTo: iso(w.afterTo),
    beforeFrom: iso(w.beforeFrom),
    beforeTo: iso(w.beforeTo),
    sideMs: w.sideMs,
    beforeMs: w.beforeMs,
    waiting: w.waiting,
    banded: w.banded,
    dead: w.dead,
    inside: inside.marks,
    insideMore: inside.more,
  };
}

function emptyResult(
  mark: ChangeMark,
  w: FingerprintCutWindows,
  inside: Inside,
  notes: string[],
  extra?: Partial<FingerprintCutResult>,
): FingerprintCutResult {
  return {
    title: formatChangeMarkLabel(mark),
    windows: windowPayload(w, inside),
    notes,
    sets: [],
    empty: extra?.empty ?? "",
    ...extra,
  };
}

export async function searchFingerprintCut(input: {
  mark: ChangeMark;
  from?: string;
  to?: string;
  range?: string;
  q?: string;
  opened?: string;
  live?: boolean;
  now?: number;
}): Promise<FingerprintCutResult> {
  const hunt = resolveHunt(input.from, input.to, input.range);
  const openedAt = parseOpened(input.opened, hunt.to);
  const now = input.now ?? Date.now();
  const w = fingerprintCutWindows({
    markTs: Date.parse(input.mark.ts),
    markEndTs: input.mark.end_ts ? Date.parse(input.mark.end_ts) : null,
    kind: input.mark.kind,
    huntFrom: Date.parse(hunt.from),
    huntTo: Date.parse(hunt.to),
    openedAt,
    minBeforeMs: fingerprintCutMinBeforeMs,
  });
  const inside = await insideMarks(input.mark, w);
  const notes = [
    ...fingerprintCutNotes(w, { live: Boolean(input.live), now }),
    ...fingerprintCutInsideNotes(inside.all),
  ];
  if (w.dead) {
    return emptyResult(input.mark, w, inside, notes);
  }
  const compiled = compiledOf(input.q);
  // #140: across a gap any line can look first seen or stopped; until it can say which, it waits.
  const held = shortAcrossCut(compiled.ast, w, now);
  if (held) {
    return emptyResult(input.mark, w, inside, notes, { held });
  }
  try {
    const [before, after] = await Promise.all([
      fingerprintCutScans.counts(iso(w.beforeFrom), iso(w.beforeTo), compiled),
      fingerprintCutScans.counts(iso(w.afterFrom), iso(w.afterTo), compiled),
    ]);
    if (
      before.length > fingerprintCutScanCap ||
      after.length > fingerprintCutScanCap
    ) {
      const reason = `More than ${fingerprintCutScanCap} fingerprints match one side of this cut. Narrow the hunt to compare complete sets.`;
      return emptyResult(input.mark, w, inside, notes, {
        empty: reason,
        scan: { source: "refused", reason },
      });
    }
    const merged = mergeFingerprintCutSides(before, after);
    if (merged.length === 0) {
      return emptyResult(input.mark, w, inside, notes, {
        empty:
          "No fingerprints in this slice. Only events carrying e1 are counted here — errors that never fingerprinted are not this list.",
      });
    }
    const classified = classifyFingerprintCut(merged);
    const shown = [
      ...capFingerprintCutSet(classified.firstSeen, (r) => r.after).rows,
      ...capFingerprintCutSet(classified.stillHere, (r) => r.after).rows,
      ...(w.waiting
        ? []
        : capFingerprintCutSet(classified.stopped, (r) => r.before).rows),
    ];
    let samples = new Map<string, Sample>();
    try {
      samples = await fingerprintCutScans.samples(
        iso(w.beforeFrom),
        iso(w.afterTo),
        iso(w.afterFrom),
        compiled,
        shown.map((row) => row.hex),
      );
    } catch (err) {
      if (!isNumericAggBudgetError(err)) {
        throw err;
      }
      notes.push(
        "Counts only — sampling this slice exceeded the scan budget. Zoom in for row text.",
      );
    }
    const beforeSpan = formatFingerprintCutDuration(w.beforeMs);
    return {
      title: formatChangeMarkLabel(input.mark),
      windows: windowPayload(w, inside),
      notes,
      sets: [
        packSet(
          "first_seen",
          "First seen",
          w.waiting
            ? `after the cut, not in the ${beforeSpan === "1h" ? "hour" : beforeSpan} before`
            : "after the cut, not in the equal window before",
          classified.firstSeen,
          (r) => r.after,
          samples,
          true,
          inside.all,
        ),
        packSet(
          "still_here",
          "Still here",
          "both sides of the cut",
          classified.stillHere,
          (r) => r.after,
          samples,
          false,
          inside.all,
        ),
        w.waiting
          ? waitingStopped(w)
          : packSet(
              "stopped",
              "Stopped",
              "before the cut, quiet after",
              classified.stopped,
              (r) => r.before,
              samples,
              false,
              inside.all,
            ),
      ],
      empty: "",
    };
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return emptyResult(input.mark, w, inside, notes, {
        empty: logsScanBudgetRefuseReason,
        scan: { source: "refused", reason: logsScanBudgetRefuseReason },
      });
    }
    throw err;
  }
}

export async function fingerprintCutRoute(c: Context): Promise<Response> {
  const markId = c.req.query("mark")?.trim() ?? "";
  if (!markId) {
    return c.json({ error: "mark is required" }, 400);
  }
  const from = c.req.query("from") ?? undefined;
  const to = c.req.query("to") ?? undefined;
  const range = c.req.query("range") ?? undefined;
  const q = c.req.query("q") ?? undefined;
  const opened = c.req.query("opened") ?? undefined;
  const live = c.req.query("live") === "1" || c.req.query("live") === "true";
  try {
    const mark = await getChangeMarkById(markId);
    if (!mark) {
      return c.json({ error: "mark not found" }, 404);
    }
    return c.json(
      await searchFingerprintCut({
        mark,
        from,
        to,
        range,
        q,
        opened,
        live,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof QueryCompileError) {
      return c.json({ error: err.message, faults: err.faults }, 400);
    }
    throw err;
  }
}

export type FirstSeenDetail = {
  hex: string;
  type: string;
  message: string;
  firstTs: string | null;
};

/** The first event of each fingerprint after the cut: its exception type, message, and time. */
async function e1FirstDetails(
  fromIso: string,
  toIso: string,
  compiled: CompiledQuery,
  hexes: string[],
): Promise<Map<string, FirstSeenDetail>> {
  if (hexes.length === 0) {
    return new Map();
  }
  const { sql, params } = logsWhere(fromIso, toIso, compiled);
  params.e1key = fingerprintAttr;
  params.typekey = "exception.type";
  const ors: string[] = [];
  hexes.forEach((hex, i) => {
    params[`h${i}`] = hex;
    ors.push(`attr_map[{e1key:String}] = {h${i}:String}`);
  });
  const rows = await clickhouseQuery<{
    hex: string;
    first_message: string;
    first_type: string;
    first_ts: string | null;
  }>(
    `
    SELECT
      attr_map[{e1key:String}] AS hex,
      argMin(message, ts) AS first_message,
      argMin(attr_map[{typekey:String}], ts) AS first_type,
      min(ts) AS first_ts
    FROM logs
    WHERE ${sql} AND (${ors.join(" OR ")})
    GROUP BY hex
    ${numericScanSettings}
    `,
    params,
  );
  const out = new Map<string, FirstSeenDetail>();
  for (const row of rows) {
    out.set(String(row.hex), {
      hex: String(row.hex),
      type: String(row.first_type ?? ""),
      message: String(row.first_message ?? ""),
      firstTs: row.first_ts ? toIsoTimestamp(String(row.first_ts)) : null,
    });
  }
  return out;
}

/** Replaceable so a test can refuse or count without ClickHouse. */
export const firstSeenScans = {
  counts: e1Counts,
  details: e1FirstDetails,
};

/**
 * The First seen set a first-seen alert pages on: the panel's windows (#111's hour minimum),
 * cut at `now`, every row, not the panel's ten.
 */
export async function fingerprintCutFirstSeen(input: {
  mark: ChangeMark;
  compiled: CompiledQuery;
  now: number;
}): Promise<{
  windows: FingerprintCutWindows;
  firstSeen: FingerprintCutSideCount[];
  refused: string | null;
}> {
  const markTs = Date.parse(input.mark.ts);
  const w = fingerprintCutWindows({
    markTs,
    markEndTs: input.mark.end_ts ? Date.parse(input.mark.end_ts) : null,
    kind: input.mark.kind,
    huntFrom: markTs - fingerprintCutMinBeforeMs,
    huntTo: input.now,
    openedAt: input.now,
    minBeforeMs: fingerprintCutMinBeforeMs,
  });
  if (w.dead) {
    return { windows: w, firstSeen: [], refused: null };
  }
  const held = shortAcrossCut(input.compiled.ast, w, input.now);
  if (held) {
    // A new fingerprint across a gap may only be one the gap hid: nothing pages until it has caught up.
    return { windows: w, firstSeen: [], refused: `${held.sources.map((s) => s.name).join(", ")} short in this window` };
  }
  try {
    const [before, after] = await Promise.all([
      firstSeenScans.counts(iso(w.beforeFrom), iso(w.beforeTo), input.compiled),
      firstSeenScans.counts(iso(w.afterFrom), iso(w.afterTo), input.compiled),
    ]);
    if (before.length > fingerprintCutScanCap || after.length > fingerprintCutScanCap) {
      return {
        windows: w,
        firstSeen: [],
        refused: `more than ${fingerprintCutScanCap} fingerprints on a side`,
      };
    }
    const { firstSeen } = classifyFingerprintCut(mergeFingerprintCutSides(before, after));
    return { windows: w, firstSeen, refused: null };
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return { windows: w, firstSeen: [], refused: logsScanBudgetRefuseReason };
    }
    throw err;
  }
}

/** Details for the fingerprints a call lists; a refused read leaves them out, not the call. */
export async function firstSeenDetails(
  windows: FingerprintCutWindows,
  compiled: CompiledQuery,
  hexes: string[],
): Promise<Map<string, FirstSeenDetail>> {
  try {
    return await firstSeenScans.details(iso(windows.afterFrom), iso(windows.afterTo), compiled, hexes);
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return new Map();
    }
    throw err;
  }
}
