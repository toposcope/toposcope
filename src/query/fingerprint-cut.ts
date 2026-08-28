import type { Context } from "hono";
import {
  formatChangeMarkLabel,
  type ChangeMark,
} from "../shared/change-mark";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { fingerprintAttr } from "../shared/fingerprint";
import {
  capFingerprintCutSet,
  classifyFingerprintCut,
  fingerprintCutNotes,
  fingerprintCutScanCap,
  fingerprintCutWindows,
  mergeFingerprintCutSides,
  type FingerprintCutResult,
  type FingerprintCutRow,
  type FingerprintCutSet,
  type FingerprintCutSideCount,
  type FingerprintCutWindows,
} from "../shared/fingerprint-cut";
import { getFieldSkipKeys } from "../shared/field-skip";
import {
  emitQuerySql,
  QueryCompileError,
  requireCompiled,
  type CompiledQuery,
} from "./compile";
import { getChangeMarkById } from "./marks";
import {
  isNumericAggBudgetError,
  logsScanBudgetRefuseReason,
  numericScanSettings,
} from "./agg";
import { rollupSource } from "./histogram";
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
    "ts <= parseDateTime64BestEffort({to:String})",
  ];
  const sql = emitQuerySql(compiled, params, "logs");
  if (sql) {
    where.push(sql);
  }
  return { sql: where.join(" AND "), params };
}

function attrMvWhere(
  fromIso: string,
  toIso: string,
  compiled: CompiledQuery,
): WhereClause {
  const params: Record<string, string> = {
    tenant_id: "default",
    from: fromIso,
    to: toIso,
    attr_key: fingerprintAttr,
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))",
    "minute <= toStartOfMinute(parseDateTime64BestEffort({to:String}))",
    "key = {attr_key:String}",
  ];
  const sql = emitQuerySql(compiled, params, "attr", fingerprintAttr);
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
  const source = rollupSource(compiled, getFieldSkipKeys());
  if (source === "minute") {
    const { sql, params } = attrMvWhere(fromIso, toIso, compiled);
    params.limit = String(fingerprintCutScanCap);
    const query = `
      SELECT value AS v, countMerge(n) AS n
      FROM logs_attr_values_by_minute
      WHERE ${sql} AND value != ''
      GROUP BY v
      ORDER BY n DESC, v ASC
      LIMIT {limit:UInt32}
      SETTINGS max_execution_time = 5
    `;
    const rows = await clickhouseQuery<CountRow>(query, params);
    return rows.map((row) => ({ hex: String(row.v), n: rowN(row.n) }));
  }
  const { sql, params } = logsWhere(fromIso, toIso, compiled);
  params.e1key = fingerprintAttr;
  params.limit = String(fingerprintCutScanCap);
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

function hms(isoStr: string): string {
  const t = isoStr.slice(11, 19);
  return t.length === 8 ? t : isoStr;
}

function toRow(
  side: FingerprintCutSideCount,
  sample: Sample | undefined,
  firstSeen: boolean,
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
): FingerprintCutSet {
  const capped = capFingerprintCutSet(sides, rank);
  return {
    id,
    name,
    def,
    count: capped.total,
    more: capped.more,
    rows: capped.rows.map((row) => toRow(row, samples.get(row.hex), firstSeen)),
  };
}

function windowPayload(w: FingerprintCutWindows) {
  return {
    afterFrom: iso(w.afterFrom),
    afterTo: iso(w.afterTo),
    beforeFrom: iso(w.beforeFrom),
    beforeTo: iso(w.beforeTo),
    sideMs: w.sideMs,
    banded: w.banded,
    dead: w.dead,
  };
}

function emptyResult(
  mark: ChangeMark,
  w: FingerprintCutWindows,
  notes: string[],
  extra?: Partial<FingerprintCutResult>,
): FingerprintCutResult {
  return {
    title: formatChangeMarkLabel(mark),
    windows: windowPayload(w),
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
  });
  const notes = fingerprintCutNotes(w, {
    live: Boolean(input.live),
    now,
  });
  if (w.dead) {
    return emptyResult(input.mark, w, notes);
  }
  const compiled = compiledOf(input.q);
  try {
    const [before, after] = await Promise.all([
      fingerprintCutScans.counts(iso(w.beforeFrom), iso(w.beforeTo), compiled),
      fingerprintCutScans.counts(iso(w.afterFrom), iso(w.afterTo), compiled),
    ]);
    const merged = mergeFingerprintCutSides(before, after);
    if (merged.length === 0) {
      return emptyResult(input.mark, w, notes, {
        empty:
          "No fingerprints in this slice. Only events carrying e1 are counted here — errors that never fingerprinted are not this list.",
      });
    }
    const classified = classifyFingerprintCut(merged);
    const shown = [
      ...capFingerprintCutSet(classified.firstSeen, (r) => r.after).rows,
      ...capFingerprintCutSet(classified.stillHere, (r) => r.after).rows,
      ...capFingerprintCutSet(classified.stopped, (r) => r.before).rows,
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
    return {
      title: formatChangeMarkLabel(input.mark),
      windows: windowPayload(w),
      notes,
      sets: [
        packSet(
          "first_seen",
          "First seen",
          "after the cut, not in the equal window before",
          classified.firstSeen,
          (r) => r.after,
          samples,
          true,
        ),
        packSet(
          "still_here",
          "Still here",
          "both sides of the cut",
          classified.stillHere,
          (r) => r.after,
          samples,
          false,
        ),
        packSet(
          "stopped",
          "Stopped",
          "before the cut, quiet after",
          classified.stopped,
          (r) => r.before,
          samples,
          false,
        ),
      ],
      empty: "",
    };
  } catch (err) {
    if (isNumericAggBudgetError(err)) {
      return emptyResult(input.mark, w, notes, {
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
