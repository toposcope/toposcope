import { activeLinks } from "../links/store";
import { feeders, gapsIn, heldSources, huntAst, type HeldLink, type HeldSource } from "../shared/held";
import type { CantTell } from "../shared/monitor";

/**
 * When a fewer-than monitor cannot tell (#176). It is the one source where a missing reading looks
 * like the condition, so every "can't tell" keeps it shut: a ClickHouse hiccup or a restart must
 * not page every quiet-stream monitor at once.
 */

let startedAt = Date.now();

/** The monitor loop starts with ingest: a window that reaches back before it may miss lines. */
export function markStarted(at = Date.now()): void {
  startedAt = at;
}

export function toposcopeStartedAt(): number {
  return startedAt;
}

/** Where each linked source stands (#139); tests swap it. */
export const cantTellHeld = {
  links: (): HeldLink[] => activeLinks(),
};

const rank = { hole: 0, behind: 1, quiet: 2 } as const;

/**
 * Why a reading of fewer than its threshold may not mean it: Toposcope has not been up for one
 * whole window, or a linked source that could feed this search is short inside the window (the
 * links floor rule, `src/shared/held.ts`), so the count is a floor. Null when it can tell.
 */
export function searchCantTell(input: {
  query: string;
  windowMs: number;
  now: number;
  startedAt: number;
  sources: HeldSource[];
}): CantTell | null {
  const { now, windowMs } = input;
  if (now - input.startedAt < windowMs) {
    return { kind: "starting", at: now, until: input.startedAt + windowMs };
  }
  if (input.sources.length === 0) {
    return null;
  }
  const gaps = gapsIn(input.sources, { from: now - windowMs, to: now }, now);
  const short = input.sources.filter((s) => gaps.some((g) => g.source === s.name));
  const feed = feeders(short, huntAst(input.query));
  if (feed.length === 0) {
    return null;
  }
  return {
    kind: "held",
    at: now,
    sources: feed.map((s) => {
      let state: "hole" | "behind" | "quiet" = "hole";
      for (const g of gaps) {
        if (g.source === s.name && rank[g.kind] > rank[state]) {
          state = g.kind;
        }
      }
      return { name: s.name, state };
    }),
  };
}

/** The same, read now for a saved search: what the pass and the editor ask. */
export function cantTellNow(query: string, windowMs: number, now = Date.now()): CantTell | null {
  return searchCantTell({
    query,
    windowMs,
    now,
    startedAt,
    sources: heldSources(cantTellHeld.links(), now),
  });
}
