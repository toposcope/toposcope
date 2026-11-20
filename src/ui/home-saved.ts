import type { HomeCard } from "../control/home-since";
import { isTextPanel, type BoardSlots } from "../shared/boards";
import { widgetGridCols } from "../shared/widgets";
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

/** Home's board tiles: boards pinned to Home first, then the API's order (newest first). */
export function homeBoards(saved: readonly SavedSearch[]): SavedSearch[] {
  return saved.filter((s) => s.board).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}
