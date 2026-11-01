import type { HomeCard } from "../control/home-since";
import type { SavedSearch } from "./types";

/**
 * Home's Saved hunts column with many hunts (frames 35a–35g): the hunts whose card moved come
 * first, the rest fold into one Quiet line, and the column scrolls inside itself to the footer.
 */

/** At this many saved hunts or fewer the column is one list, as before (35g). */
export const foldPast = 8;

export type MovedHunt = { item: SavedSearch; card: HomeCard };
export type SavedColumn = { fold: false; items: SavedSearch[] } | { fold: true; moved: MovedHunt[]; quiet: SavedSearch[] };

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

/** `items` come newest first, as the API lists them; Quiet keeps that order. */
export function savedColumn(items: readonly SavedSearch[], cards: readonly HomeCard[]): SavedColumn {
  if (items.length <= foldPast) {
    return { fold: false, items: [...items] };
  }
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
  // a stable sort keeps newest first among equal moves
  moved.sort((a, b) => moveSize(b.card) - moveSize(a.card));
  return { fold: true, moved, quiet };
}
