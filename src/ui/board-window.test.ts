import { describe, expect, test } from "bun:test";
import { boardOpenRange, boardRange, boardSavedRange, boardUnsaved, linkedRange } from "./board-window";

/** How App opens a board from a link once its saved searches load. */
const openFromLink = (search: string, saved: string | null) => boardOpenRange(saved, linkedRange(search));

describe("a board opens at its own window (50e)", () => {
  test("a link with no range opens at the board's window, and reads saved", () => {
    // logs.agental.io, 0.15.6: `?saved=<id>` read the Hunt tab's 1h and showed unsaved at once.
    const range = openFromLink("?saved=abc", "24h");
    expect(range).toBe("24h");
    expect(boardUnsaved("24h", range)).toBe(false);
  });

  test("from Home or the palette: the board's window", () => {
    expect(boardOpenRange("24h", null)).toBe("24h");
    expect(boardOpenRange("7d", null)).toBe("7d");
    expect(boardUnsaved("24h", boardOpenRange("24h", null))).toBe(false);
  });

  test("a link that names a window opens at it, and that is a change", () => {
    const range = openFromLink("?saved=abc&range=6h", "24h");
    expect(range).toBe("6h");
    expect(boardUnsaved("24h", range)).toBe(true);
  });

  test("a custom window in a link, or none saved, falls back", () => {
    expect(openFromLink("?saved=abc&range=custom&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z", "24h")).toBe("24h");
    expect(boardOpenRange(null, null)).toBe("1h");
    expect(boardOpenRange("nonsense", null)).toBe("1h");
    expect(boardSavedRange(undefined)).toBe("1h");
  });

  test("a link names a window only with range=", () => {
    expect(linkedRange("?saved=abc")).toBeNull();
    expect(linkedRange("?saved=abc&range=4h")).toBe("4h");
    expect(linkedRange("")).toBeNull();
  });

  test("unsaved only when the window really changed", () => {
    expect(boardUnsaved("24h", "24h")).toBe(false);
    expect(boardUnsaved("24h", "1h")).toBe(true);
    expect(boardUnsaved(null, "1h")).toBe(false);
    expect(boardUnsaved(null, "4h")).toBe(true);
    // A board cannot keep a custom window; it saves as 1h.
    expect(boardRange("custom")).toBe("1h");
    expect(boardUnsaved("1h", "custom")).toBe(false);
  });
});
