import type { SavedSearch } from "./types";

/**
 * The header field's suggestions (sheet 49b): saved hunts and boards whose names hold every word
 * typed, names that start with it first. A few of each; Enter with none highlighted still opens a
 * hunt with what was typed. Archived ones are left out (sheet 50).
 */
export const suggestionsPer = 4;

export type HeaderSuggestions = { hunts: SavedSearch[]; boards: SavedSearch[] };

function score(name: string, words: string[], whole: string): number | null {
  const n = name.toLowerCase();
  if (!words.every((w) => n.includes(w))) {
    return null;
  }
  if (n === whole) {
    return 0;
  }
  if (n.startsWith(whole)) {
    return 1;
  }
  return n.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(words[0]!)) ? 2 : 3;
}

export function headerSuggestions(saved: readonly SavedSearch[], typed: string, per = suggestionsPer): HeaderSuggestions {
  const whole = typed.trim().toLowerCase().replace(/\s+/g, " ");
  if (!whole) {
    return { hunts: [], boards: [] };
  }
  const words = whole.split(" ");
  const ranked = saved
    // an archived hunt or board is off search (sheet 50)
    .filter((item) => !item.archived)
    .map((item, i) => ({ item, i, s: score(item.name, words, whole) }))
    .filter((r): r is { item: SavedSearch; i: number; s: number } => r.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((r) => r.item);
  return {
    hunts: ranked.filter((s) => !s.board).slice(0, per),
    boards: ranked.filter((s) => s.board).slice(0, per),
  };
}

/** The suggestions in the order the arrow keys walk them: hunts, then boards. */
export function suggestionOrder(s: HeaderSuggestions): SavedSearch[] {
  return [...s.hunts, ...s.boards];
}
