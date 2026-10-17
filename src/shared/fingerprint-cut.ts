import type { HeldSource } from "./held";
import type { ChangeMarkKind } from "./change-mark";

/** Drawn rows per set — same grain as Top-N default. */
export const fingerprintCutCap = 10;

/** Distinct e1 values fetched per side before classifying. */
export const fingerprintCutScanCap = 200;

/** Panel note when the after side is this short. */
export const fingerprintCutShortMs = 5 * 60_000;

/** Fingerprints compare a young mark with at least this much before it; Compare keeps equal sides. */
export const fingerprintCutMinBeforeMs = 60 * 60_000;

/** Other marks named inside a cut's sides: enough for a morning of five deploys. */
export const fingerprintCutInsideCap = 4;

export type FingerprintCutWindows = {
  afterFrom: number;
  afterTo: number;
  beforeFrom: number;
  beforeTo: number;
  /** The after side's length. */
  sideMs: number;
  /** The before side's length: sideMs, or the minimum while the after side is shorter. */
  beforeMs: number;
  /** Stopped is not called until the after side is as long as the before side. */
  waiting: boolean;
  banded: boolean;
  dead: boolean;
  pastPlotFrom: boolean;
  openIncident: boolean;
};

export type FingerprintCutSideCount = {
  hex: string;
  before: number;
  after: number;
};

export function fingerprintCutWindows(input: {
  markTs: number;
  markEndTs: number | null;
  kind: ChangeMarkKind;
  huntFrom: number;
  huntTo: number;
  openedAt: number;
  /** A closed band keeps equal sides: it will not grow into the minimum. */
  minBeforeMs?: number;
}): FingerprintCutWindows {
  const openIncident =
    input.kind === "incident" &&
    (input.markEndTs == null || input.markEndTs > input.openedAt);
  const banded =
    input.kind === "incident" &&
    input.markEndTs != null &&
    input.markEndTs <= input.openedAt;
  const afterFrom = input.markTs;
  const afterTo = banded
    ? input.markEndTs!
    : Math.min(input.openedAt, input.huntTo);
  const sideMs = afterTo - afterFrom;
  const dead = sideMs <= 0;
  const after = Math.max(0, sideMs);
  const beforeMs =
    dead || banded ? after : Math.max(after, input.minBeforeMs ?? 0);
  const beforeTo = afterFrom;
  const beforeFrom = afterFrom - beforeMs;
  return {
    afterFrom,
    afterTo,
    beforeFrom,
    beforeTo,
    sideMs: after,
    beforeMs,
    waiting: !dead && after < beforeMs,
    banded,
    dead,
    pastPlotFrom: !dead && beforeFrom < input.huntFrom,
    openIncident,
  };
}

export function classifyFingerprintCut(
  rows: FingerprintCutSideCount[],
): {
  firstSeen: FingerprintCutSideCount[];
  stillHere: FingerprintCutSideCount[];
  stopped: FingerprintCutSideCount[];
} {
  const firstSeen: FingerprintCutSideCount[] = [];
  const stillHere: FingerprintCutSideCount[] = [];
  const stopped: FingerprintCutSideCount[] = [];
  for (const row of rows) {
    if (row.before === 0 && row.after > 0) {
      firstSeen.push(row);
    } else if (row.before > 0 && row.after > 0) {
      stillHere.push(row);
    } else if (row.before > 0 && row.after === 0) {
      stopped.push(row);
    }
  }
  return { firstSeen, stillHere, stopped };
}

export function capFingerprintCutSet<T>(
  rows: T[],
  rank: (row: T) => number,
): { rows: T[]; total: number; more: number } {
  const ranked = rows.slice().sort((a, b) => rank(b) - rank(a));
  const total = ranked.length;
  const capped = ranked.slice(0, fingerprintCutCap);
  return { rows: capped, total, more: Math.max(0, total - capped.length) };
}

export function mergeFingerprintCutSides(
  before: Array<{ hex: string; n: number }>,
  after: Array<{ hex: string; n: number }>,
): FingerprintCutSideCount[] {
  const map = new Map<string, FingerprintCutSideCount>();
  for (const row of before) {
    map.set(row.hex, { hex: row.hex, before: row.n, after: 0 });
  }
  for (const row of after) {
    const prev = map.get(row.hex);
    if (prev) {
      prev.after = row.n;
    } else {
      map.set(row.hex, { hex: row.hex, before: 0, after: row.n });
    }
  }
  return [...map.values()].filter((row) => row.before + row.after > 0);
}

export function fingerprintCutNotes(
  windows: FingerprintCutWindows,
  input: { live: boolean; now: number },
): string[] {
  const notes: string[] = [];
  if (windows.dead) {
    notes.push("The window ends before this mark — there is no after side to cut.");
    return notes;
  }
  const after = formatFingerprintCutDuration(windows.sideMs);
  const before = formatFingerprintCutDuration(windows.beforeMs);
  const span = before === "1h" ? "hour" : before;
  if (windows.waiting && windows.sideMs < fingerprintCutShortMs) {
    notes.push(
      `Only ${after} since the cut. First seen is against the ${span} before; Stopped waits for the after side to have that ${span} too.`,
    );
  } else if (windows.waiting) {
    notes.push(
      `The sides differ until the after side has ${span === "hour" ? "an hour" : before}: counts read ${before} before → ${after} after.`,
    );
  } else if (!windows.banded && windows.sideMs < fingerprintCutShortMs) {
    notes.push(
      `Only ${after} since the cut — both sides are that short. Early to call anything stopped.`,
    );
  }
  if (windows.openIncident) {
    notes.push("The incident is still open — the cut sits at its start, not a band.");
  }
  if (windows.pastPlotFrom) {
    notes.push(
      "The before side reads past the plot's left edge — same q, older data. The plot is not the query.",
    );
  }
  if (input.live && !windows.banded && input.now - windows.afterTo > 1000) {
    notes.push(
      `Fixed when opened — ${formatFingerprintCutDuration(input.now - windows.afterTo)} ago. Live moves the plot, not the cut; reopen to re-cut at now.`,
    );
  }
  return notes;
}

export type FingerprintCutRow = {
  hex: string;
  message: string;
  service: string;
  level: string;
  before: number;
  after: number;
  extra: string;
  /** A first seen row after a later mark inside the after side: "after v0.9.3". */
  follows: string;
};

/** Another mark inside a cut's sides, named so a cut over a burst of deploys says so. */
export type FingerprintCutInsideMark = {
  id: string;
  kind: ChangeMarkKind;
  ts: string;
  label: string;
  title: string;
  side: "before" | "after";
};

export type FingerprintCutSet = {
  id: "first_seen" | "still_here" | "stopped";
  name: string;
  def: string;
  count: number;
  more: number;
  rows: FingerprintCutRow[];
  /** Stopped while the after side is shorter than the before side: not called yet. */
  waiting?: { haveMs: number; needMs: number };
};

export type FingerprintCutResult = {
  title: string;
  windows: {
    afterFrom: string;
    afterTo: string;
    beforeFrom: string;
    beforeTo: string;
    sideMs: number;
    beforeMs: number;
    waiting: boolean;
    banded: boolean;
    dead: boolean;
    inside: FingerprintCutInsideMark[];
    insideMore: number;
  };
  notes: string[];
  sets: FingerprintCutSet[];
  empty: string;
  scan?: { source: "refused"; reason: string };
  /**
   * #140: sources that could feed the hunt and are short inside the cut's windows. While there is
   * one, the cut refuses: no sets and no counts, only which side misses rows and from whom.
   */
  held?: { sides: "both" | "before" | "after"; sources: HeldSource[] };
};

export function formatFingerprintCutDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs >= 86_400_000 && abs % 86_400_000 === 0) {
    return `${abs / 86_400_000}d`;
  }
  if (abs >= 3_600_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    if (m === 0) {
      return `${h}h`;
    }
    return m === 60 ? `${h + 1}h` : `${h}h ${m}m`;
  }
  if (abs >= 60_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.round((abs % 60_000) / 1000);
    if (s === 0) {
      return `${m}m`;
    }
    return `${m}m ${s}s`;
  }
  if (abs >= 1000) {
    return `${Math.max(1, Math.round(abs / 1000))}s`;
  }
  return `${Math.max(1, abs)}ms`;
}

const countWords = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "Two more deploys are inside the after side." — one sentence a side, kind when they share one. */
export function fingerprintCutInsideNotes(inside: FingerprintCutInsideMark[]): string[] {
  const notes: string[] = [];
  for (const side of ["after", "before"] as const) {
    const marks = inside.filter((m) => m.side === side);
    if (marks.length === 0) {
      continue;
    }
    const n = marks.length;
    const kinds = new Set(marks.map((m) => m.kind));
    const kind = kinds.size === 1 ? [...kinds][0]! : "mark";
    const noun = `${kind}${n === 1 ? "" : "s"}`;
    const count = n < countWords.length ? countWords[n]! : String(n);
    const head = `${count[0]!.toUpperCase()}${count.slice(1)} more ${noun} ${n === 1 ? "is" : "are"} inside the ${side} side.`;
    notes.push(
      side === "after"
        ? `${head} A first seen row's time says which one it follows.`
        : head,
    );
  }
  return notes;
}

/** The latest later mark inside the after side at or before a first seen row's first event. */
export function fingerprintCutFollows(
  inside: FingerprintCutInsideMark[],
  firstAfterIso: string | null,
): string {
  if (!firstAfterIso) {
    return "";
  }
  const at = Date.parse(firstAfterIso);
  let best: FingerprintCutInsideMark | null = null;
  for (const mark of inside) {
    const ts = Date.parse(mark.ts);
    if (mark.side === "after" && ts <= at && (!best || ts >= Date.parse(best.ts))) {
      best = mark;
    }
  }
  return best ? `after ${best.title}` : "";
}

/** Over the cap, name the marks nearest the cut, in time order. */
export function nearestInsideMarks(
  inside: FingerprintCutInsideMark[],
  cutTs: number,
  cap: number,
): FingerprintCutInsideMark[] {
  if (inside.length <= cap) {
    return inside;
  }
  return inside
    .slice()
    .sort((a, b) => Math.abs(Date.parse(a.ts) - cutTs) - Math.abs(Date.parse(b.ts) - cutTs))
    .slice(0, cap)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
