import { describe, expect, test } from "bun:test";
import type { HomeCard } from "../control/home-since";
import { cardMoved, foldPast, savedColumn } from "./home-saved";
import type { SavedSearch } from "./types";

const hunt = (id: string): SavedSearch => ({ id, name: id }) as SavedSearch;
const card = (saved_id: string, before: number | null, after: number | null, refused: string | null = null): HomeCard => ({
  saved_id,
  name: saved_id,
  kind: "count",
  before,
  after,
  refused,
  spark: [],
  split_at: 0,
  saved_by: null,
  shared: true,
});

describe("Home's Saved hunts column (35a–35g)", () => {
  test("a card moved only when both sides were read and differ", () => {
    expect(cardMoved(card("a", 3, 12))).toBe(true);
    expect(cardMoved(card("a", 0, 3))).toBe(true);
    expect(cardMoved(card("a", 41, 38))).toBe(true);
    expect(cardMoved(card("a", 0, 0))).toBe(false);
    expect(cardMoved(card("a", null, 3))).toBe(false);
    expect(cardMoved(card("a", 0, 3, "scan budget"))).toBe(false);
    expect(cardMoved(undefined)).toBe(false);
  });

  test(`${foldPast} hunts or fewer stay one list in the API's order (35g)`, () => {
    const items = Array.from({ length: foldPast }, (_, i) => hunt(`h${i}`));
    const column = savedColumn(items, [card("h3", 0, 9)]);
    expect(column).toEqual({ fold: false, items });
  });

  test("past that, moved hunts come first, new before the largest change, the rest quiet in order (35e)", () => {
    const items = Array.from({ length: 12 }, (_, i) => hunt(`h${i}`));
    const cards = [card("h1", 100, 110), card("h4", 0, 3), card("h6", 3, 12), card("h8", 5, 5), card("h9", 0, 2, "refused")];
    const column = savedColumn(items, cards);
    if (!column.fold) {
      throw new Error("expected a fold");
    }
    expect(column.moved.map((m) => m.item.id)).toEqual(["h4", "h6", "h1"]);
    expect(column.quiet.map((s) => s.id)).toEqual(["h0", "h2", "h3", "h5", "h7", "h8", "h9", "h10", "h11"]);
  });

  test("nothing moved: every hunt is quiet (35a's all-zero list)", () => {
    const items = Array.from({ length: 40 }, (_, i) => hunt(`h${i}`));
    const column = savedColumn(items, items.map((s) => card(s.id, 0, 0)));
    expect(column.fold && column.moved.length).toBe(0);
    expect(column.fold && column.quiet.length).toBe(40);
  });
});
