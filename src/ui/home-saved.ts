import type { HomeCard } from "../control/home-since";
import { isTextPanel, type BoardSlots } from "../shared/boards";
import { coverageGaps, type Coverage } from "../shared/coverage";
import { widgetGridCols } from "../shared/widgets";
import { formatCompactCount } from "./count-format";
import { formatValue } from "./home-since";
import type { SavedSearch } from "./types";

/**
 * Home's saved hunts and boards (sheet 49b): the hunts whose card moved are cards, the rest fold
 * into one Quiet line; boards are tiles with a sketch of their layout.
 */

export type MovedHunt = { item: SavedSearch; card: HomeCard };
export type HomeHunts = { moved: MovedHunt[]; quiet: SavedSearch[] };

/** A card moved when both sides were read and they differ; refused or unread cards are quiet. */
export function cardMoved(card: HomeCard | undefined): card is HomeCard {
  return Boolean(card && !card.refused && card.before !== null && card.after !== null && card.before !== card.after);
}

/** How far a card moved, for the order: new first, then the largest change against its before. */
function moveSize(card: HomeCard): number {
  const before = card.before ?? 0;
  const after = card.after ?? 0;
  if (before === 0) {
    return Number.MAX_VALUE;
  }
  return Math.abs(after - before) / Math.abs(before);
}

/**
 * `items` come newest first, as the API lists them. Moved hunts order by how far they moved;
 * Quiet keeps the API's order with hunts pinned to Home first.
 */
export function splitHunts(items: readonly SavedSearch[], cards: readonly HomeCard[]): HomeHunts {
  const byId = new Map(cards.map((c) => [c.saved_id, c]));
  const moved: MovedHunt[] = [];
  const quiet: SavedSearch[] = [];
  for (const item of items) {
    const card = byId.get(item.id);
    if (cardMoved(card)) {
      moved.push({ item, card });
    } else {
      quiet.push(item);
    }
  }
  // stable sorts keep newest first among equals
  moved.sort((a, b) => moveSize(b.card) - moveSize(a.card));
  quiet.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  return { moved, quiet };
}

/** A board tile's counts: panels that read rows, and sections; notes are neither. */
export function boardCounts(board: BoardSlots | null | undefined): { panels: number; sections: number } {
  const panels = board?.panels ?? [];
  return {
    panels: panels.filter((p) => !isTextPanel(p.view)).length,
    sections: panels.filter((p) => p.view === "section").length,
  };
}

/** "5 panels · 2 sections", "1 panel", "no panels". */
export function boardCountText(board: BoardSlots | null | undefined): string {
  const { panels, sections } = boardCounts(board);
  const head = panels === 0 ? "no panels" : `${panels} panel${panels === 1 ? "" : "s"}`;
  return sections > 0 ? `${head} · ${sections} section${sections === 1 ? "" : "s"}` : head;
}

/** One box of a board tile's sketch, in percent of the sketch. */
export type PreviewBox = { id: string; left: number; top: number; width: number; height: number };

/** A board tile's sketch: each panel that reads rows at its cell on the 12-column grid. */
export function boardPreview(board: BoardSlots | null | undefined): PreviewBox[] {
  const cells = (board?.panels ?? []).filter((p) => !isTextPanel(p.view));
  const rows = Math.max(1, ...cells.map((p) => p.widget.y + p.widget.h));
  return cells.map((p) => {
    const x = Math.max(0, Math.min(widgetGridCols, p.widget.x));
    const w = Math.max(1, Math.min(widgetGridCols - x, p.widget.w));
    return {
      id: p.id,
      left: (x / widgetGridCols) * 100,
      top: (Math.max(0, p.widget.y) / rows) * 100,
      width: (w / widgetGridCols) * 100,
      height: (Math.max(1, p.widget.h) / rows) * 100,
    };
  });
}

/** Home's board tiles: boards pinned to Home first, then the API's order (newest first). Archived boards are not tiles. */
export function homeBoards(saved: readonly SavedSearch[]): SavedSearch[] {
  return saved.filter((s) => s.board && !s.archived).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

/** The saved hunts Home reads (sheet 50): not boards, not archived. */
export function homeHunts(saved: readonly SavedSearch[]): SavedSearch[] {
  return saved.filter((s) => !s.board && !s.archived);
}

/** The Archived line's rows (50b): archived hunts, then archived boards, each in the API's order. */
export function archivedSaved(saved: readonly SavedSearch[]): SavedSearch[] {
  const archived = saved.filter((s) => s.archived);
  return [...archived.filter((s) => !s.board), ...archived.filter((s) => s.board)];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "20 saved hunts, not read on Home"; boards are named when there are any. */
export function archivedText(archived: readonly SavedSearch[]): string {
  const boards = archived.filter((s) => s.board).length;
  const hunts = archived.length - boards;
  const parts = [hunts > 0 ? plural(hunts, "saved hunt", "saved hunts") : null, boards > 0 ? plural(boards, "board", "boards") : null].filter(Boolean);
  return `${parts.join(" and ")}, not read on Home`;
}

/** "31 saved hunts, same as before". */
export function quietText(count: number): string {
  return `${plural(count, "saved hunt", "saved hunts")}, same as before`;
}

/** A Quiet row's value: `refused`, a compact count, or the series' value; empty when not read. */
export function quietValue(card: HomeCard | undefined): string {
  if (!card) {
    return "";
  }
  if (card.refused) {
    return "refused";
  }
  return card.kind === "count" ? formatCompactCount(card.after ?? 0) : formatValue(card.after, card.kind);
}

/** How many Quiet names the folded line spells out before `+N`. */
export const quietNamesShown = 3;

/**
 * The folded Quiet line's right side (50b): the quiet hunts whose value is not zero, the largest
 * first, three by name and the rest as `+N`; null when every one reads zero.
 * "2 not zero: Fleet job silent 27 · API event loop stalls 13".
 */
export function quietNotZero(quiet: readonly SavedSearch[], cards: readonly HomeCard[], shown = quietNamesShown): string | null {
  const byId = new Map(cards.map((c) => [c.saved_id, c]));
  const rows = quiet
    .map((item) => ({ item, card: byId.get(item.id) }))
    .filter((r): r is { item: SavedSearch; card: HomeCard } => Boolean(r.card && !r.card.refused && r.card.after !== null && r.card.after !== 0))
    .sort((a, b) => Math.abs(b.card.after!) - Math.abs(a.card.after!));
  if (rows.length === 0) {
    return null;
  }
  const named = rows.slice(0, shown).map((r) => `${r.item.name} ${quietValue(r.card)}`);
  const more = rows.length - named.length;
  return `${rows.length} not zero: ${named.join(" · ")}${more > 0 ? ` +${more}` : ""}`;
}

/** Fewer buckets than this with any value, and a Moved card draws before and after instead (50b). */
export const sparkMinBuckets = 4;

/** Whether a Moved card draws two bars, before and after, in place of its sparkline (50b). */
export function drawsBeforeAfter(card: Pick<HomeCard, "spark">): boolean {
  return card.spark.filter((v) => v > 0).length < sparkMinBuckets;
}

/** The before and after bars' lengths, in percent of the card: the larger side is full. */
export function beforeAfterWidths(before: number | null, after: number | null): { before: number; after: number } {
  const b = Math.abs(before ?? 0);
  const a = Math.abs(after ?? 0);
  const top = Math.max(b, a);
  if (top === 0) {
    return { before: 0, after: 0 };
  }
  return { before: (b / top) * 100, after: (a / top) * 100 };
}

/** The folded Coverage line (51b): the one gap worth fixing first, its fix, and how many more. */
export type CoverageLead = { text: string; fix: string; href: string | null; more: number };

/**
 * Coverage leads with one gap (51b): the first Home would list ("api: no version: …"), its fix,
 * and the services with gaps after it; null, and no line, when the coverage card would show nothing.
 */
export function coverageLead(coverage: Coverage | null, selectedMarkId: string | null): CoverageLead | null {
  if (!coverage) {
    return null;
  }
  const gaps = coverageGaps(coverage, selectedMarkId);
  const withGaps = coverage.services.filter((s) => !s.complete).length;
  const first = gaps[0];
  if (!first) {
    const names = coverage.mismatches.length;
    return names > 0 ? { text: `${names} ${names === 1 ? "name does" : "names do"} not match`, fix: "Names that do not match ›", href: null, more: 0 } : null;
  }
  return { text: `${first.service}: ${first.what}`, fix: first.fix, href: first.href, more: Math.max(0, withGaps - (first.mark ? 0 : 1)) };
}

/** The Quiet hunts that read only gone hosts (51b), in Quiet's order. */
export function goneInQuiet(quiet: readonly SavedSearch[], goneIds: readonly string[]): SavedSearch[] {
  const ids = new Set(goneIds);
  return quiet.filter((s) => ids.has(s.id));
}

/** "18 saved hunts read hosts that sent nothing in 7 days" (51b). */
export function goneText(n: number): string {
  return `${n} saved ${n === 1 ? "hunt reads hosts" : "hunts read hosts"} that sent nothing in 7 days`;
}

/** When a gone host last sent anything (51c): "since 11-03", or "nothing kept" when no line is. */
export function goneSince(lastSeen: string | null): string {
  return lastSeen ? `since ${lastSeen.slice(5, 10)}` : "nothing kept";
}

/**
 * A busy Moved card's buckets as two rows (51b): before the mark and after it, each scaled to the
 * larger bucket of both, as percentages, so the card reads like the before and after bars.
 */
export function sparkRows(spark: readonly number[], splitAt: number): { before: number[]; after: number[] } {
  const peak = Math.max(1, ...spark);
  const pct = (v: number) => Math.max(4, Math.round((v / peak) * 100));
  return { before: spark.slice(0, splitAt).map(pct), after: spark.slice(splitAt).map(pct) };
}
