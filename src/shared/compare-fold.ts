import { fingerprintCutShortMs, type FingerprintCutWindows } from "./fingerprint-cut";

/** Unicode minus — the fold paints −12% / −418, not a hyphen. */
export const compareFoldMinus = "\u2212";

export type CompareFoldKind = "count" | "rate" | "numeric" | "metric";

export type CompareFoldSide = {
  v: number | null;
  n: number;
  empty: boolean;
  refused: boolean;
};

export function compareFoldKind(
  agg: string | null,
  metric: string | null,
): CompareFoldKind {
  if (metric) {
    return "metric";
  }
  if (!agg) {
    return "count";
  }
  if (agg.trim().toLowerCase() === "rate") {
    return "rate";
  }
  return "numeric";
}

/** Percent needs a before. First-seen (before = 0) drops it; stopped is −100%. */
export function compareFoldPercent(
  before: number | null,
  after: number | null,
): number | null {
  if (before == null || after == null) {
    return null;
  }
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return null;
  }
  return ((after - before) / before) * 100;
}

export function formatCompareFoldPercent(p: number): string {
  const sign = p >= 0 ? "+" : compareFoldMinus;
  const abs = Math.abs(p);
  const body =
    abs >= 9.5
      ? String(Math.round(abs))
      : abs >= 0.95
        ? abs.toFixed(1)
        : "<1";
  return `${sign}${body}%`;
}

export function compareFoldSideFromSearch(
  json: {
    total: number;
    agg?: { stat: number | null; source: string } | null;
    scan?: { source: string } | null;
  },
  kind: CompareFoldKind,
): CompareFoldSide {
  const refused =
    json.scan?.source === "refused" || json.agg?.source === "refused";
  if (kind === "metric") {
    const v = refused ? null : (json.agg?.stat ?? null);
    const ok = v != null && Number.isFinite(v);
    return { v: ok ? v : null, n: ok ? 1 : 0, empty: !ok, refused };
  }
  const n = json.total;
  if (kind === "count") {
    return {
      v: refused ? null : n,
      n,
      empty: n === 0,
      refused,
    };
  }
  if (kind === "rate") {
    const v = refused ? null : (json.agg?.stat ?? (n === 0 ? 0 : null));
    return {
      v: v != null && Number.isFinite(v) ? v : null,
      n,
      empty: n === 0,
      refused,
    };
  }
  const v = refused || n === 0 ? null : (json.agg?.stat ?? null);
  return {
    v: v != null && Number.isFinite(v) ? v : null,
    n,
    empty: n === 0,
    refused,
  };
}

export function compareFoldSeriesText(input: {
  e1: string[];
  agg: string | null;
  metric: string | null;
}): { text: string; overlay: boolean } {
  if (input.metric) {
    return { text: input.metric, overlay: true };
  }
  if (input.agg) {
    const parsed = input.agg.trim().toLowerCase();
    if (parsed === "rate") {
      return { text: "Rate", overlay: true };
    }
    const colon = input.agg.indexOf(":");
    if (colon > 0) {
      return {
        text: `${input.agg.slice(0, colon)}(${input.agg.slice(colon + 1)})`,
        overlay: true,
      };
    }
    return { text: input.agg, overlay: true };
  }
  if (input.e1.length === 1) {
    return { text: `e1:${input.e1[0]} · count`, overlay: false };
  }
  return { text: "Count", overlay: false };
}

export function compareFoldNote(input: {
  windows: FingerprintCutWindows;
  kind: CompareFoldKind;
  before: CompareFoldSide;
  after: CompareFoldSide;
  formatDuration: (ms: number) => string;
}): string {
  if (input.windows.dead) {
    return "the window ends before this mark — nothing after to read";
  }
  if (input.before.refused || input.after.refused) {
    return "";
  }
  const logEmpty = input.kind !== "metric";
  if (logEmpty && input.before.empty && input.after.empty) {
    return "no events on either side — nothing to number";
  }
  if (logEmpty && input.before.empty && !input.after.empty) {
    return "new since this mark — a percent needs a before";
  }
  if (logEmpty && !input.before.empty && input.after.empty) {
    return "quiet after this mark";
  }
  if (
    !input.windows.banded &&
    input.windows.sideMs > 0 &&
    input.windows.sideMs < fingerprintCutShortMs
  ) {
    return `only ${input.formatDuration(input.windows.sideMs)} since the mark — sides are as long as exist`;
  }
  return "";
}

export function compareFoldSidesText(input: {
  windows: FingerprintCutWindows;
  frozen: boolean;
  frozenStamp: string;
  formatDuration: (ms: number) => string;
}): string {
  if (input.windows.dead) {
    return "";
  }
  const core = input.windows.banded
    ? `the band · ${input.formatDuration(input.windows.sideMs)}, mirrored`
    : `equal ${input.formatDuration(input.windows.sideMs)}`;
  return input.frozen ? `${core} · fixed ${input.frozenStamp}` : core;
}

export function compareFoldShowDelta(
  windows: FingerprintCutWindows,
  kind: CompareFoldKind,
  before: CompareFoldSide,
  after: CompareFoldSide,
): boolean {
  if (windows.dead || before.refused || after.refused) {
    return false;
  }
  if (kind !== "metric" && before.empty && after.empty) {
    return false;
  }
  return true;
}
