import type { AlertRule, SavedSearch } from "@/types";
import { showsNoLogRows } from "../shared/widgets";

/**
 * How the sidebar's Saved list reads once it holds many items (#168, frames
 * 16a–16n): names that share their first words fold into a group, a kind
 * column says what each item is, and a filter finds one by name.
 */

/** Past this many saved searches, a filter sits at the top of Saved (16b). */
export const filterPast = 8;
/** Past this many, groups start closed (16c). */
export const closedPast = 20;
/** A group needs this many names that share the words before a colon (16b). */
export const groupAtLeast = 3;

/** What a saved search is, as the kind column draws it: a bell, sliders, squares, or nothing. */
export type SavedKind = "watched" | "board" | "panels";

/** A board cannot be watched; a watched search kept for its panels shows the bell (16j). */
export function savedKind(item: SavedSearch, alerts: readonly AlertRule[]): SavedKind | null {
  if (item.board) {
    return "board";
  }
  if (alerts.some((rule) => rule.saved_search_id === item.id)) {
    return "watched";
  }
  if (showsNoLogRows(item.widgets)) {
    return "panels";
  }
  return null;
}

/** The words before the first colon, when there are words on both sides of it. */
export function namePrefix(name: string): { prefix: string; rest: string } | null {
  const at = name.indexOf(":");
  if (at < 0) {
    return null;
  }
  const prefix = name.slice(0, at).trim();
  const rest = name.slice(at + 1).trim();
  return prefix && rest ? { prefix, rest } : null;
}

export type SavedRow = { item: SavedSearch; /** What the row prints: the name, or inside a group the rest of it. */ text: string };
export type SavedEntry =
  | { type: "row"; row: SavedRow }
  | { type: "group"; prefix: string; rows: SavedRow[] };

/**
 * Searches outside any group first, newest first, then the groups in the order
 * of their newest search. `items` come newest first, as the API lists them.
 */
export function groupSaved(items: readonly SavedSearch[]): SavedEntry[] {
  const sharing = new Map<string, number>();
  for (const item of items) {
    const split = namePrefix(item.name);
    if (split) {
      sharing.set(split.prefix, (sharing.get(split.prefix) ?? 0) + 1);
    }
  }
  const loose: SavedEntry[] = [];
  const groups = new Map<string, SavedRow[]>();
  for (const item of items) {
    const split = namePrefix(item.name);
    if (split && (sharing.get(split.prefix) ?? 0) >= groupAtLeast) {
      const rows = groups.get(split.prefix) ?? [];
      rows.push({ item, text: split.rest });
      groups.set(split.prefix, rows);
    } else {
      loose.push({ type: "row", row: { item, text: item.name } });
    }
  }
  return [...loose, ...[...groups].map(([prefix, rows]): SavedEntry => ({ type: "group", prefix, rows }))];
}

/** Where `find` sits in `text`, ignoring case, or null. */
export function matchIn(text: string, find: string): { start: number; end: number } | null {
  const needle = find.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const start = text.toLowerCase().indexOf(needle);
  return start < 0 ? null : { start, end: start + needle.length };
}

/** The saved searches a filter and a kind button leave: the filter reads whole names, never queries (16d). */
export function filterSaved(
  items: readonly SavedSearch[],
  find: string,
  kind: SavedKind | null,
  kindOf: (item: SavedSearch) => SavedKind | null,
): SavedSearch[] {
  return items.filter((item) => (!find.trim() || matchIn(item.name, find) !== null) && (!kind || kindOf(item) === kind));
}

/** How many of each kind the list has, for the buttons beside the filter: only kinds it has (16f). */
export function kindCounts(
  items: readonly SavedSearch[],
  kindOf: (item: SavedSearch) => SavedKind | null,
): Array<{ kind: SavedKind; n: number }> {
  const order: SavedKind[] = ["watched", "board", "panels"];
  const n = new Map<SavedKind, number>();
  for (const item of items) {
    const kind = kindOf(item);
    if (kind) {
      n.set(kind, (n.get(kind) ?? 0) + 1);
    }
  }
  return order.filter((kind) => (n.get(kind) ?? 0) > 0).map((kind) => ({ kind, n: n.get(kind)! }));
}

/** Words for a kind button and the line under the filter. */
export const kindWords: Record<SavedKind, { only: (n: number) => string; note: string; adjective: string }> = {
  watched: { only: (n) => `Only the ${n} an alert watches`, note: "watched by an alert", adjective: "watched" },
  board: { only: (n) => (n === 1 ? "Only the board" : `Only the ${n} boards`), note: "boards", adjective: "board" },
  panels: { only: (n) => `Only the ${n} kept for their panels`, note: "kept for their panels", adjective: "panels-only" },
};

/** What the line under the filter says, or null when nothing is narrowed. */
export function narrowedNote(shown: number, total: number, kind: SavedKind | null, find: string): string | null {
  if (!kind && !find.trim()) {
    return null;
  }
  return `${shown} of ${total}${kind ? ` · ${kindWords[kind].note}` : ""}`;
}

/** What Saved says when the filter leaves nothing (16e). */
export function noMatchLine(find: string, kind: SavedKind | null): string {
  const what = kind ? `${kindWords[kind].adjective} saved search` : "saved search";
  return `No ${what} has “${find.trim()}” in its name.`;
}

/** Groups start closed past `closedPast` saved searches; what someone opened or closed wins. */
export function groupOpen(prefix: string, total: number, remembered: Readonly<Record<string, boolean>>): boolean {
  return remembered[prefix] ?? total <= closedPast;
}

/** The sidebar's own width: 240 by default, 400 at most, and never so wide the plot has under 640 (16l). */
export const sidebarDefault = 240;
export const sidebarMost = 400;
export const plotLeast = 640;

/**
 * The width a drag or a key asks for, kept inside 240–400 and stopped where
 * the plot beside it would get narrower than 640. `plotNow` is the plot's
 * width at the sidebar's `current` width.
 */
export function clampSidebar(wanted: number, current: number, plotNow: number): number {
  const roomToGrow = Math.max(0, plotNow - plotLeast);
  const most = Math.max(sidebarDefault, Math.min(sidebarMost, current + roomToGrow));
  return Math.round(Math.min(most, Math.max(sidebarDefault, wanted)));
}
