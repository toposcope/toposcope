/**
 * Coverage (#391, frames 37j and 37k): how much of each service carries the keys an investigation
 * reads (docs/evidence.md), and the names that should be one thing but are two. Everything here is
 * pure: the counts come from the minute rollups and the marks (query/coverage.ts), and the words
 * Fields and Home say are made here so both say the same.
 */

/** A key is complete at 90% of the service's rows. */
export const COVERAGE_COMPLETE = 0.9;

/** The keys a row of Coverage counts, in the order the table draws them. */
export const coverageKeys = ["version", "host", "trace_id", "stack"] as const;
export type CoverageKey = (typeof coverageKeys)[number];
/** What a gap can be on: a key, or the service's deploy marks. */
export const gapKeys = [...coverageKeys, "marks"] as const;
export type GapKey = (typeof gapKeys)[number];

export function isGapKey(v: unknown): v is GapKey {
  return typeof v === "string" && (gapKeys as readonly string[]).includes(v);
}

/** An accepted gap (#392), as Fields lists it (37o). */
export type AcceptedGap = {
  service: string;
  key: GapKey;
  /** The share when it was accepted (0 for a deploy mark). */
  share: number;
  /** The share now, or null when the window has nothing to measure it on. */
  now: number | null;
  by: string | null;
  /** The accepter's role now (viewer, operator, owner), for the hover; absent for a token. */
  by_role?: string;
  at: number;
  /** holds: not counted as a gap; back: its share fell below `share`, so it counts again. */
  state: "holds" | "back";
};

export type CoverageService = {
  service: string;
  rows: number;
  /** error and fatal rows: what `stack` is a share of. */
  errors: number;
  /** Share of rows, 0–1. */
  version: number;
  host: number;
  /** null: the service sends no spans, so trace_id is not counted. */
  trace_id: number | null;
  /** Share of error/fatal rows with a stack; null with no error rows. */
  stack: number | null;
  marks: { count: number; last: string | null };
  complete: boolean;
  /** Gaps accepted on this service that still hold (#392). */
  accepted?: GapKey[];
};

export type CoverageMismatch =
  | {
      kind: "service";
      /** The name on logs. */
      service: string;
      rows: number;
      /** The other name, on spans, metrics or marks. */
      other: string;
      spans: number | null;
      metric_names: number | null;
      marks: number | null;
    }
  | {
      kind: "version";
      service: string;
      /** The `version` value on the service's rows, and how many rows the service has. */
      rows_value: string;
      rows: number;
      /** The deploy mark's `version`. */
      mark_value: string;
      /** The service's most common other version, the release before as its rows name it. */
      prior: string | null;
      mark_id: string;
      mark_ts: string;
    };

export type Coverage = {
  from: string;
  to: string;
  threshold: number;
  services: CoverageService[];
  /** Services with every applicable key complete and a deploy mark in the window. */
  complete: number;
  mismatches: CoverageMismatch[];
  /** Every accepted gap in force, holding or come back (#392). */
  accepted?: AcceptedGap[];
};

export type CoverageInput = {
  from: string;
  to: string;
  /** logs_by_minute per service. */
  logs: Array<{ service: string; rows: number; host_rows: number; error_rows: number }>;
  /** logs_attr_keys_by_minute: `version` and `trace_id` on all rows, the stack on error/fatal rows. */
  keys: Array<{ service: string; version: number; trace_id: number; stack: number }>;
  /** logs_attr_values_by_minute: `version` values per service. */
  versions: Array<{ service: string; value: string; n: number }>;
  /** Deploy marks in the window, newest first. */
  deploys: Array<{ id: string; ts: string; service: string; version: string }>;
  /** Service names on spans and metrics, null when that list could not be read. */
  spans: Array<{ service: string; n: number }> | null;
  metrics: Array<{ service: string; names: number }> | null;
};

function share(n: number, of: number): number {
  return of > 0 ? Math.min(1, n / of) : 0;
}

/** The form two names are compared in: case, a leading `v`, and an `-api` / `-svc` suffix do not count. */
export function nameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/-(api|svc)$/, "")
    .replace(/^v(?=[0-9])/, "");
}

/** `v1.4.2` ↔ `1.4.2`: the one other form of a version. */
function otherVersion(value: string): string {
  return /^v/i.test(value) ? value.slice(1) : `v${value}`;
}

export function isComplete(s: Omit<CoverageService, "complete">): boolean {
  const held = new Set(s.accepted ?? []);
  const shares = coverageKeys.filter((k) => !held.has(k)).map((k) => s[k]).filter((v): v is number => v !== null);
  return (s.marks.count > 0 || held.has("marks")) && shares.every((v) => v >= COVERAGE_COMPLETE);
}

/** A gap's share now: the key's share, or for marks 1 with one and 0 without. */
export function gapShare(s: CoverageService, key: GapKey): number | null {
  return key === "marks" ? (s.marks.count > 0 ? 1 : 0) : s[key];
}

/** Whether this cell is a gap: under 90%, or no deploy mark. */
export function isGap(s: CoverageService, key: GapKey): boolean {
  const v = gapShare(s, key);
  return v !== null && v < COVERAGE_COMPLETE;
}

export type AcceptedRow = { service: string; key: GapKey; share: number; by: string | null; at: number };

/**
 * Fold the accepted gaps into a coverage answer (#392). An accepted gap holds while its share is
 * at least what it was when accepted; below that it comes back and counts again. One whose key has
 * reached 90% (or whose service got a deploy mark) is in `cleared`, for the store to drop.
 */
export function applyAccepted(c: Coverage, rows: AcceptedRow[]): { coverage: Coverage; cleared: AcceptedRow[] } {
  const bySvc = new Map(c.services.map((s) => [s.service, s]));
  const accepted: AcceptedGap[] = [];
  const cleared: AcceptedRow[] = [];
  const holds = new Map<string, GapKey[]>();
  for (const r of rows) {
    const s = bySvc.get(r.service);
    const now = s ? gapShare(s, r.key) : null;
    if (now !== null && now >= COVERAGE_COMPLETE) {
      cleared.push(r);
      continue;
    }
    // compared at the table's own precision, so 12.4% → 12.1% is no fall
    const back = now !== null && Math.floor(now * 100) < Math.floor(r.share * 100);
    accepted.push({ ...r, now, state: back ? "back" : "holds" });
    if (!back) {
      holds.set(r.service, [...(holds.get(r.service) ?? []), r.key]);
    }
  }
  const services = c.services.map((s) => {
    const keys = holds.get(s.service);
    if (!keys) {
      return s;
    }
    const next = { ...s, accepted: keys };
    return { ...next, complete: isComplete(next) };
  });
  accepted.sort((a, b) => b.at - a.at);
  return {
    coverage: { ...c, services, complete: services.filter((s) => s.complete).length, accepted },
    cleared,
  };
}

export function buildCoverage(input: CoverageInput): Coverage {
  const keys = new Map(input.keys.map((k) => [k.service, k]));
  const spanServices = input.spans ? new Map(input.spans.map((s) => [s.service, s.n])) : null;
  const marksBy = new Map<string, { count: number; last: string | null }>();
  for (const d of input.deploys) {
    const cur = marksBy.get(d.service) ?? { count: 0, last: null };
    cur.count += 1;
    if (!cur.last || d.ts > cur.last) {
      cur.last = d.ts;
    }
    marksBy.set(d.service, cur);
  }
  const services: CoverageService[] = [...input.logs]
    .filter((l) => l.service !== "" && l.rows > 0)
    .sort((a, b) => b.rows - a.rows || a.service.localeCompare(b.service))
    .map((l) => {
      const k = keys.get(l.service);
      const base = {
        service: l.service,
        rows: l.rows,
        errors: l.error_rows,
        version: share(k?.version ?? 0, l.rows),
        host: share(l.host_rows, l.rows),
        trace_id: spanServices?.has(l.service) ? share(k?.trace_id ?? 0, l.rows) : null,
        stack: l.error_rows > 0 ? share(k?.stack ?? 0, l.error_rows) : null,
        marks: marksBy.get(l.service) ?? { count: 0, last: null },
      };
      return { ...base, complete: isComplete(base) };
    });

  const logNames = new Map(services.map((s) => [s.service, s]));
  const byKey = new Map<string, CoverageService>();
  for (const s of services) {
    if (!byKey.has(nameKey(s.service))) {
      byKey.set(nameKey(s.service), s);
    }
  }
  const mismatches: CoverageMismatch[] = [];
  const others = new Set<string>([
    ...(input.spans ?? []).map((s) => s.service),
    ...(input.metrics ?? []).map((m) => m.service),
    ...input.deploys.map((d) => d.service),
  ]);
  const metricNames = new Map((input.metrics ?? []).map((m) => [m.service, m.names]));
  const markCount = new Map([...marksBy].map(([svc, m]) => [svc, m.count]));
  for (const other of [...others].sort()) {
    if (!other || logNames.has(other)) {
      continue;
    }
    const logs = byKey.get(nameKey(other));
    if (!logs) {
      continue;
    }
    mismatches.push({
      kind: "service",
      service: logs.service,
      rows: logs.rows,
      other,
      spans: spanServices?.get(other) ?? null,
      metric_names: metricNames.get(other) ?? null,
      marks: markCount.get(other) ?? null,
    });
  }

  const values = new Map<string, Map<string, number>>();
  for (const v of input.versions) {
    const m = values.get(v.service) ?? new Map<string, number>();
    m.set(v.value, (m.get(v.value) ?? 0) + v.n);
    values.set(v.service, m);
  }
  const seen = new Set<string>();
  for (const d of [...input.deploys].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const s = logNames.get(d.service);
    const on = values.get(d.service);
    if (!s || !on || !d.version || on.has(d.version) || seen.has(`${d.service}\n${d.version}`)) {
      continue;
    }
    const twin = otherVersion(d.version);
    if (!on.has(twin)) {
      continue;
    }
    seen.add(`${d.service}\n${d.version}`);
    mismatches.push({
      kind: "version",
      service: d.service,
      rows_value: twin,
      rows: s.rows,
      mark_value: d.version,
      prior:
        [...on]
          .filter(([value]) => value !== twin && value !== d.version)
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      mark_id: d.id,
      mark_ts: d.ts,
    });
  }

  return {
    from: input.from,
    to: input.to,
    threshold: COVERAGE_COMPLETE,
    services,
    complete: services.filter((s) => s.complete).length,
    mismatches,
  };
}

/** A share as the table prints it: floored, so 89.6% never reads as complete. */
export function coveragePercent(v: number): string {
  return `${Math.floor(v * 100)}%`;
}

export type CoverageGap = {
  service: string;
  /** What the row stands on, in a line (37k). */
  what: string;
  fix: string;
  /** A doc to read, or null for a place in the app. */
  href: string | null;
  /** The selected mark's version does not match its rows. */
  mark?: boolean;
};

const docs = "https://github.com/toposcope/toposcope/blob/main/docs";
export const evidenceDocUrl = `${docs}/evidence.md`;
export const namesDocUrl = `${docs}/evidence.md#names-have-to-match`;
export const keysDocUrl = `${docs}/evidence.md#the-keys`;
export const marksDocUrl = `${docs}/evidence.md#mark-every-change`;
export const stackDocUrl = `${docs}/ingest.md#exception-fingerprints`;

/** The one gap a service's line on Home names: its lowest share, a missing mark last. */
function worstGap(s: CoverageService): { key: CoverageKey | "marks"; v: number } | null {
  const order: CoverageKey[] = ["version", "stack", "trace_id", "host"];
  const held = new Set(s.accepted ?? []);
  let worst: { key: CoverageKey | "marks"; v: number } | null = null;
  for (const key of order) {
    const v = held.has(key) ? null : s[key];
    if (v !== null && v < COVERAGE_COMPLETE && (worst === null || v < worst.v)) {
      worst = { key, v };
    }
  }
  if (worst === null && s.marks.count === 0 && !held.has("marks")) {
    return { key: "marks", v: 0 };
  }
  return worst;
}

/** One line for each service that is not complete, as Home lists them (37k): the worst first. */
export function coverageGaps(c: Coverage, selectedMarkId: string | null): CoverageGap[] {
  const out: Array<CoverageGap & { rank: number }> = [];
  const marked = c.mismatches.find((m) => m.kind === "version" && m.mark_id === selectedMarkId);
  for (const s of c.services) {
    if (marked?.kind === "version" && marked.service === s.service) {
      out.push({
        service: s.service,
        what: `this mark says ${marked.mark_value}, its rows say ${marked.rows_value}: the rows it shipped cannot be told from the ones before`,
        fix: "Names that do not match ›",
        href: null,
        mark: true,
        rank: -1,
      });
      continue;
    }
    if (s.complete) {
      continue;
    }
    const gap = worstGap(s);
    if (!gap) {
      continue;
    }
    const pct = coveragePercent(gap.v);
    const rank = gap.v + ["version", "stack", "trace_id", "host", "marks"].indexOf(gap.key) * 1e-3;
    if (gap.key === "version") {
      const noMark = s.marks.count === 0 && !s.accepted?.includes("marks");
      out.push({
        service: s.service,
        what:
          gap.v === 0
            ? `no version${noMark ? " and no deploy mark" : ""}: a ${s.service} release never becomes the mark Home measures from`
            : `version on ${pct} of rows: the rest cannot be told apart by release`,
        fix: "Send version ↗",
        href: keysDocUrl,
        rank,
      });
    } else if (gap.key === "stack") {
      out.push({
        service: s.service,
        what: `${coveragePercent(1 - gap.v)} of its errors carry no stack: their fingerprint comes from the message, so a reworded one reads as new`,
        fix: "Attach the exception ↗",
        href: stackDocUrl,
        rank,
      });
    } else if (gap.key === "trace_id") {
      out.push({
        service: s.service,
        what: `trace_id on ${pct} of rows: View trace is missing on ${gap.v < 0.5 ? "most" : "some"} of them`,
        fix: "Log inside a span ↗",
        href: keysDocUrl,
        rank,
      });
    } else if (gap.key === "host") {
      out.push({
        service: s.service,
        what: `host on ${pct} of rows: Compare cannot split the rest by host`,
        fix: "Send host ↗",
        href: keysDocUrl,
        rank,
      });
    } else {
      out.push({
        service: s.service,
        what: `no deploy mark in 24 h: a ${s.service} release never becomes the mark Home measures from`,
        fix: "Mark every change ↗",
        href: marksDocUrl,
        rank,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...g }) => g);
}

export type CoverageNote =
  | { service: string; kind: "version"; noMark: boolean }
  | { service: string; kind: "stack"; missing: string };

/**
 * The sentences under the Coverage table (37j), for the gaps that cost Home its answer: a service
 * with no `version` at all, else one whose errors mostly come without a stack. One for each service.
 */
export function coverageNotes(c: Coverage): CoverageNote[] {
  const out: CoverageNote[] = [];
  for (const s of c.services) {
    const held = new Set(s.accepted ?? []);
    if (s.version === 0 && !held.has("version")) {
      out.push({ service: s.service, kind: "version", noMark: s.marks.count === 0 && !held.has("marks") });
    } else if (s.stack !== null && s.stack < 0.5 && !held.has("stack")) {
      out.push({ service: s.service, kind: "stack", missing: coveragePercent(1 - s.stack) });
    }
  }
  return out;
}

/** Where a mismatch's other name was seen: "spans · 210K · metrics · 14 names". */
export function mismatchOn(m: CoverageMismatch, count: (n: number) => string): string {
  if (m.kind === "version") {
    return `deploy mark`;
  }
  const parts: string[] = [];
  if (m.spans !== null) {
    parts.push(`spans · ${count(m.spans)}`);
  }
  if (m.metric_names !== null) {
    parts.push(`metrics · ${m.metric_names} ${m.metric_names === 1 ? "name" : "names"}`);
  }
  if (m.marks !== null) {
    parts.push(`marks · ${m.marks}`);
  }
  return parts.join(" · ");
}

/** The "So" column (37j). */
export function mismatchSo(m: CoverageMismatch): string {
  if (m.kind === "version") {
    return `The mark is not tied to the rows it shipped, so nothing can tell ${m.rows_value} rows from ${m.prior ? `${m.prior} rows around it` : "the release before it"}.`;
  }
  const where = m.spans !== null ? "spans" : m.metric_names !== null ? "metrics" : "marks";
  const lost =
    m.spans !== null && m.metric_names !== null
      ? "the metrics or the waterfall"
      : m.spans !== null
        ? "the waterfall"
        : m.metric_names !== null
          ? "the metrics"
          : "the deploy marks";
  return `Its ${where} and its logs read as two services: a hunt on service:${m.service} never shows ${lost} beside its rows.`;
}

/** Whether a service's missing stacks are an accepted gap that holds: the event panel says nothing then (37l). */
export function stackAccepted(c: Coverage | null, service: string): boolean {
  return c?.services.find((s) => s.service === service)?.accepted?.includes("stack") ?? false;
}
