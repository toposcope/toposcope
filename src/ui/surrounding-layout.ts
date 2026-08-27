import type { LogEvent } from "../shared/log-event";
import { surroundingMaxN } from "../query/surrounding";
import type { ContextMode } from "./context-mode";

export { surroundingMaxN };

/** Event Surroundings: older above, center, newer below. */
export function surroundingEventRows(
  before: readonly LogEvent[],
  event: LogEvent,
  after: readonly LogEvent[],
): LogEvent[] {
  return [...before, event, ...after];
}

/**
 * Mark Surroundings: older above, newer below. The mark is a plate, not a log
 * row — it is not in this list.
 */
export function surroundingMarkLogRows(
  before: readonly LogEvent[],
  after: readonly LogEvent[],
): LogEvent[] {
  return [...before, ...after];
}

/** Index of the center plate / event in the painted list. */
export function surroundingAnchorIndex(beforeCount: number): number {
  return beforeCount;
}

export function surroundingHasMore(
  side: readonly unknown[],
  n: number,
  maxN = surroundingMaxN,
): boolean {
  return n < maxN && side.length >= n;
}

/**
 * ScrollTop that puts the anchor row's vertical midpoint on the scroller's.
 * ContextView writes this instead of `scrollIntoView`, which would also move
 * the page around the reader.
 */
export function surroundingAnchorScrollTop(
  scroller: { top: number; height: number; scrollTop: number },
  row: { top: number; height: number },
): number {
  return (
    scroller.scrollTop +
    (row.top + row.height / 2) -
    (scroller.top + scroller.height / 2)
  );
}

/**
 * Hunt `q` is All-analog on mark focus: never sent on `/api/search/around`.
 * Event Surroundings only ANDs `q` in Matching.
 */
export function surroundingFetchQ(
  markFocus: boolean,
  mode: ContextMode,
  q: string,
): string | undefined {
  if (markFocus) {
    return undefined;
  }
  const query = q.trim();
  return mode === "match" && query.length > 0 ? query : undefined;
}
