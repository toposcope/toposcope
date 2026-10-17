import { FOLLOW_MS } from "./ids";
import { formatFingerprintCutDuration } from "./fingerprint-cut";

/** How far either side of the event Follow looks for the value's first and last row. */
export const followReachMs = 24 * 3_600_000;

/** Read past each end of the day, to say when the value's story runs longer. */
export const followEdgeMs = 3_600_000;

/**
 * `/api/search/follow-span`: rows carrying the value within a day either side.
 * `pastBefore`/`pastAfter`: seen in the hour past that end, so the window is cut at a day.
 */
export type FollowSpan = {
  n: number | null;
  first: string | null;
  last: string | null;
  pastBefore?: boolean;
  pastAfter?: boolean;
  refused?: string;
};

/**
 * What the Follow tab opened on. `span`: first to last seen. The rest open ±5m:
 * `once` (one row), `none` (no row found), `refused` (over the scan budget), `failed`.
 */
export type FollowOpenedHow = "span" | "once" | "none" | "refused" | "failed";

/** `cut`: first to last seen stopped at a day on that side, with the value still seen past it. */
export type FollowCut = "before" | "after" | "both";

export type FollowOpened = {
  how: FollowOpenedHow;
  fromMs: number;
  toMs: number;
  cut?: FollowCut;
};

function wholeSeconds(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  return {
    fromMs: Math.floor(fromMs / 1000) * 1000,
    toMs: Math.ceil(toMs / 1000) * 1000,
  };
}

/**
 * First to last seen, never shorter than the ±5m window; widened out to whole
 * seconds so the last row stays inside `to` whatever the column's precision.
 */
export function followOpened(atMs: number, span: FollowSpan | null): FollowOpened {
  const around = (how: FollowOpenedHow): FollowOpened => ({
    how,
    ...wholeSeconds(atMs - FOLLOW_MS, atMs + FOLLOW_MS),
  });
  if (!span) {
    return around("failed");
  }
  if (span.refused || span.n === null) {
    return around("refused");
  }
  const firstMs = span.first ? Date.parse(span.first) : Number.NaN;
  const lastMs = span.last ? Date.parse(span.last) : Number.NaN;
  if (span.n <= 0 || Number.isNaN(firstMs) || Number.isNaN(lastMs)) {
    return around("none");
  }
  if (span.n === 1) {
    return around("once");
  }
  let fromMs = Math.min(firstMs, atMs);
  let toMs = Math.max(lastMs, atMs) + 1;
  if (toMs - fromMs < 2 * FOLLOW_MS) {
    const mid = (fromMs + toMs) / 2;
    fromMs = mid - FOLLOW_MS;
    toMs = mid + FOLLOW_MS;
  }
  const opened: FollowOpened = { how: "span", ...wholeSeconds(fromMs, toMs) };
  const cut: FollowCut | null =
    span.pastBefore && span.pastAfter
      ? "both"
      : span.pastBefore
        ? "before"
        : span.pastAfter
          ? "after"
          : null;
  if (cut) {
    opened.cut = cut;
  }
  return opened;
}

const cutWords: Record<FollowCut, string> = {
  before: "cut at a day before",
  after: "cut at a day after",
  both: "cut at a day either side",
};

export function followOpenedWords(how: FollowOpenedHow): string {
  switch (how) {
    case "span":
      return "opened on first to last seen";
    case "once":
      return "opened ±5m · seen once within a day";
    case "none":
      return "opened ±5m · not found within a day";
    case "refused":
      return "opened ±5m · finding its first and last row was too large a read";
    case "failed":
      return "opened ±5m · its first and last row could not be read";
  }
}

/** The chip on the opened window; a first to last seen cut at a day says so. */
export function followChipWords(opened: FollowOpened): string {
  const base = followOpenedWords(opened.how);
  return opened.how === "span" && opened.cut ? `${base} · ${cutWords[opened.cut]}` : base;
}

/** Once the clock moves off it, the chip says how long the opened window was. */
export function followChangedWords(opened: FollowOpened): string {
  if (opened.how !== "span") {
    return followOpenedWords(opened.how);
  }
  return `${followChipWords(opened)} · ${formatFingerprintCutDuration(opened.toMs - opened.fromMs)}`;
}

export function followSpanSearchParams(q: string, atIso: string): URLSearchParams {
  return new URLSearchParams({ q, at: atIso });
}
