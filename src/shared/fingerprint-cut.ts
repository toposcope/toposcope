import type { ChangeMarkKind } from "./change-mark";

/** Drawn rows per set — same grain as Top-N default. */
export const fingerprintCutCap = 10;

/** Distinct e1 values fetched per side before classifying. */
export const fingerprintCutScanCap = 200;

/** Panel note when both sides are this short. */
export const fingerprintCutShortMs = 5 * 60_000;

export type FingerprintCutWindows = {
  afterFrom: number;
  afterTo: number;
  beforeFrom: number;
  beforeTo: number;
  sideMs: number;
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
  const beforeTo = afterFrom;
  const beforeFrom = afterFrom - Math.max(0, sideMs);
  return {
    afterFrom,
    afterTo,
    beforeFrom,
    beforeTo,
    sideMs: Math.max(0, sideMs),
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
  if (!windows.banded && windows.sideMs < fingerprintCutShortMs) {
    notes.push(
      `Only ${formatFingerprintCutDuration(windows.sideMs)} since the cut — both sides are that short. Early to call anything stopped.`,
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
};

export type FingerprintCutSet = {
  id: "first_seen" | "still_here" | "stopped";
  name: string;
  def: string;
  count: number;
  more: number;
  rows: FingerprintCutRow[];
};

export type FingerprintCutResult = {
  title: string;
  windows: {
    afterFrom: string;
    afterTo: string;
    beforeFrom: string;
    beforeTo: string;
    sideMs: number;
    banded: boolean;
    dead: boolean;
  };
  notes: string[];
  sets: FingerprintCutSet[];
  empty: string;
  scan?: { source: "refused"; reason: string };
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
