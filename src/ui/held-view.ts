import { parseRangeMs } from "../query/relative";
import {
  feeders,
  filterImplied,
  gapsIn,
  huntAst,
  omitKey,
  shortIn,
  type HeldGap,
  type HeldSource,
  type Window,
} from "../shared/held";
import { hatchLabel, pillWords, tableRowAt, tableRowWords } from "../shared/held-words";

/**
 * What Search draws for what this instance holds (#139), for one hunt over one window. Nothing
 * at all on an instance that pulls from no one.
 */
export type HeldView = {
  sources: HeldSource[];
  now: number;
  live: boolean;
  /** The window the view was made for: a metric panel over the board reads its own tells from it (#331). */
  window: Window;
  /** The hunt's own count is a floor. */
  floor: boolean;
  /** Gaps inside the window of the sources that could feed the hunt. */
  gaps: HeldGap[];
  pill: string | null;
  hatches: Array<HeldGap & { label: string }>;
  rows: Array<{ at: number; text: string; key: string }>;
  /** The grey scope beside the count: rows behind it came through a filter the hunt does not imply. */
  chip: ScopeChip | null;
  /** A facet value's count is a floor. */
  facetFloor: (field: string, value: string) => boolean;
  /** Gaps that make another count a floor: its own query over its own window. */
  countGaps: (q: string, window: Window, value?: { key: string; value: string }) => HeldGap[];
};

export type ScopeChip = {
  /** Shown when part of the count came through the filter; absent when all of it did. */
  count: number | null;
  /** One filter, word for word, and its source; or how many filters. */
  filter: string | null;
  from: string | null;
  filters: number;
};

export function heldView(input: {
  sources: HeldSource[];
  now: number;
  live: boolean;
  window: Window;
  q: string;
  /** The hunt's count per source, from the `toposcope` facet. */
  counts: Map<string, number>;
  total: number;
}): HeldView | null {
  const { sources, now, live, window, q, counts, total } = input;
  if (sources.length === 0) {
    return null;
  }
  const hunt = huntAst(q);
  const short = Number.isFinite(window.from) && Number.isFinite(window.to) ? shortIn(sources, window, now) : [];
  const feeding = new Set(feeders(short, hunt).map((s) => s.name));
  const gaps = gapsIn(sources, window, now).filter((g) => feeding.has(g.source));
  const shortCount = new Set(gaps.map((g) => g.source)).size;
  const hatches = gaps.map((gap) => ({ ...gap, label: hatchLabel(gap, sources, shortCount) }));
  const rows = gaps.map((gap) => ({
    at: Math.max(window.from, Math.min(window.to, tableRowAt(gap))),
    text: tableRowWords(gap, sources, now),
    key: `held:${gap.source}:${gap.kind}`,
  }));
  return {
    sources,
    now,
    live,
    window,
    floor: gaps.length > 0,
    gaps,
    pill: pillWords(gaps, sources, now, live),
    hatches,
    rows,
    chip: scopeChip(sources, hunt, counts, total),
    facetFloor: (field, value) => feeders(short, omitKey(hunt, field), { key: field, value }).length > 0,
    countGaps: (other, win, value) => {
      const ast = huntAst(other);
      const s = shortIn(sources, win, now);
      const names = new Set(feeders(s, ast, value).map((x) => x.name));
      return gapsIn(sources, win, now).filter((g) => names.has(g.source));
    },
  };
}

function scopeChip(
  sources: HeldSource[],
  hunt: ReturnType<typeof huntAst>,
  counts: Map<string, number>,
  total: number,
): ScopeChip | null {
  const through = sources.filter(
    (s) => s.filters.length > 0 && (counts.get(s.name) ?? 0) > 0 && !s.filters.every((f) => filterImplied(f, hunt)),
  );
  if (through.length === 0) {
    return null;
  }
  const n = through.reduce((sum, s) => sum + (counts.get(s.name) ?? 0), 0);
  const filters = through.flatMap((s) => s.filters);
  const one = through.length === 1 && filters.length === 1;
  return {
    count: n < total ? n : null,
    filter: one ? filters[0]! : null,
    from: one ? through[0]!.name : null,
    filters: filters.length,
  };
}

/** A saved search's own window: its range back from now, or its fixed from and to. */
export function savedWindow(
  saved: { range: string | null; from_ts: string | null; to_ts: string | null },
  now: number,
): Window | null {
  if (saved.range) {
    const ms = parseRangeMs(saved.range);
    return ms ? { from: now - ms, to: now } : null;
  }
  const from = saved.from_ts ? Date.parse(saved.from_ts) : NaN;
  const to = saved.to_ts ? Date.parse(saved.to_ts) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}

/**
 * What a metric panel says while a source is short inside its window (#331, 33e). A sum or a
 * count over it is a floor: the pill names the source. An average or a percentile keeps its
 * number and is named partial, never a floor. A log hunt does not reach metric points, so only a
 * `toposcope` matcher on the panel rules a source out.
 */
export type MetricHeld = {
  /** A sum or a count: at least this much. */
  floor: boolean;
  /** The pill: the source named, and for an average or a percentile that the reading is partial. */
  pill: string;
  hatches: Array<HeldGap & { label: string }>;
};

/** Whether a metric's reading adds up, so a short source makes it a floor: a counter, a histogram's count or sum. */
export function metricAdds(result: { kind?: string; reading?: string } | null | undefined): boolean {
  return result?.kind === "counter" || (result?.kind === "histogram" && (result.reading === "count" || result.reading === "sum"));
}

export function metricHeld(
  held: HeldView | null,
  panel: { labels?: Record<string, string>; adds: boolean; reading: string },
): MetricHeld | null {
  if (!held) {
    return null;
  }
  const { sources, now, live, window } = held;
  const only = panel.labels?.toposcope;
  const gaps = gapsIn(sources, window, now).filter((g) => only === undefined || g.source === only);
  if (gaps.length === 0) {
    return null;
  }
  const pill = pillWords(gaps, sources, now, live)!;
  const shortCount = new Set(gaps.map((g) => g.source)).size;
  return {
    floor: panel.adds,
    pill: panel.adds ? pill : `${pill} · ${panel.reading || "reading"} is partial`,
    hatches: gaps.map((gap) => ({ ...gap, label: hatchLabel(gap, sources, shortCount) })),
  };
}
