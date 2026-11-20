import { parseRangeMs } from "../query/relative";
import { parseSearchUrl, type RangeMode } from "./search-url";

/**
 * A board's own window (sheet 50, 50e). A board opens at the window it saved, and reads
 * `all changes saved` until its window is changed.
 */

/** The window a board saved: a relative range (`24h`); anything else is `1h`. */
export function boardSavedRange(saved: string | null | undefined): string {
  return saved && parseRangeMs(saved) !== null ? saved : "1h";
}

/** A board's window is relative (Quick or Last N); a custom one saves as `1h`. */
export function boardRange(mode: RangeMode): string {
  return mode !== "custom" && parseRangeMs(mode) !== null ? mode : "1h";
}

/** The window a link names (`range=6h`); null when it names none and the board's own is meant. */
export function linkedRange(search: string): RangeMode | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.has("range") ? parseSearchUrl(search).range : null;
}

/**
 * The window a board opens at: the one its link names (`?saved=…&range=6h`), or else its own.
 * A link with no range, or a custom one a board cannot keep, opens at the board's.
 */
export function boardOpenRange(saved: string | null | undefined, linked: RangeMode | null): RangeMode {
  if (linked && linked !== "custom" && parseRangeMs(linked) !== null) {
    return linked;
  }
  return boardSavedRange(saved) as RangeMode;
}

/** Unsaved: the window the board shows is not the one it saved. Opening it never makes it so. */
export function boardUnsaved(saved: string | null | undefined, range: RangeMode): boolean {
  return boardSavedRange(saved) !== boardRange(range);
}
