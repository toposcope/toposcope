import { describe, expect, test } from "bun:test";
import type { HomeCard } from "../control/home-since";
import { boardCountText, boardCounts, boardPreview, cardMoved, homeBoards, splitHunts } from "./home-saved";
import type { BoardPanel } from "../shared/boards";
import type { SavedSearch } from "./types";

const hunt = (id: string, pinned = false): SavedSearch => ({ id, name: id, pinned }) as SavedSearch;
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

describe("Home's Moved and Quiet (49b)", () => {
  test("a card moved only when both sides were read and differ", () => {
    expect(cardMoved(card("a", 3, 12))).toBe(true);
    expect(cardMoved(card("a", 0, 3))).toBe(true);
    expect(cardMoved(card("a", 41, 38))).toBe(true);
    expect(cardMoved(card("a", 0, 0))).toBe(false);
    expect(cardMoved(card("a", null, 3))).toBe(false);
    expect(cardMoved(card("a", 0, 3, "scan budget"))).toBe(false);
    expect(cardMoved(undefined)).toBe(false);
  });

  test("moved hunts, new before the largest change; the rest quiet in order", () => {
    const items = Array.from({ length: 12 }, (_, i) => hunt(`h${i}`));
    const cards = [card("h1", 100, 110), card("h4", 0, 3), card("h6", 3, 12), card("h8", 5, 5), card("h9", 0, 2, "refused")];
    const split = splitHunts(items, cards);
    expect(split.moved.map((m) => m.item.id)).toEqual(["h4", "h6", "h1"]);
    expect(split.quiet.map((s) => s.id)).toEqual(["h0", "h2", "h3", "h5", "h7", "h8", "h9", "h10", "h11"]);
  });

  test("a few hunts split too: there is no list-them-all size any more", () => {
    const split = splitHunts([hunt("a"), hunt("b")], [card("b", 1, 2)]);
    expect(split.moved.map((m) => m.item.id)).toEqual(["b"]);
    expect(split.quiet.map((s) => s.id)).toEqual(["a"]);
  });

  test("hunts pinned to Home lead Quiet", () => {
    const split = splitHunts([hunt("a"), hunt("b", true), hunt("c")], []);
    expect(split.quiet.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  test("nothing moved: every hunt is quiet", () => {
    const items = Array.from({ length: 40 }, (_, i) => hunt(`h${i}`));
    const split = splitHunts(items, items.map((s) => card(s.id, 0, 0)));
    expect(split.moved.length).toBe(0);
    expect(split.quiet.length).toBe(40);
  });
});

describe("Home's board tiles (49b)", () => {
  const panel = (id: string, view: BoardPanel["view"], x = 0, y = 0, w = 6, h = 4): BoardPanel => ({
    id,
    name: id,
    q: "",
    view,
    widget: { x, y, w, h } as BoardPanel["widget"],
    fixed: null,
  });
  const slots = (panels: BoardPanel[]) => ({ keys: [], panels });

  test("panels leave out sections and notes; sections count apart", () => {
    const board = slots([panel("u", "section"), panel("v", "stat"), panel("w", "histogram"), panel("x", "note"), panel("y", "section"), panel("z", "top"), panel("a", "events"), panel("b", "stat")]);
    expect(boardCounts(board)).toEqual({ panels: 5, sections: 2 });
    expect(boardCountText(board)).toBe("5 panels · 2 sections");
  });

  test("one panel is singular; no sections, no section count; empty reads no panels", () => {
    expect(boardCountText(slots([panel("u", "stat")]))).toBe("1 panel");
    expect(boardCountText(slots([panel("u", "stat"), panel("v", "section")]))).toBe("1 panel · 1 section");
    expect(boardCountText(slots([]))).toBe("no panels");
    expect(boardCountText(null)).toBe("no panels");
  });

  test("the sketch puts each panel at its cell on the 12-column grid", () => {
    const boxes = boardPreview(slots([panel("u", "stat", 0, 0, 6, 2), panel("v", "section", 0, 2, 12, 1), panel("w", "histogram", 6, 0, 6, 4)]));
    expect(boxes).toEqual([
      { id: "u", left: 0, top: 0, width: 50, height: 50 },
      { id: "w", left: 50, top: 0, width: 50, height: 100 },
    ]);
  });

  test("a cell past the grid's edge is clipped to it", () => {
    const [box] = boardPreview(slots([panel("u", "stat", 10, 0, 6, 1)]));
    expect(box!.left + box!.width).toBeCloseTo(100);
  });

  test("boards pinned to Home come first; hunts are not boards", () => {
    const b = (id: string, pinned = false) => ({ ...hunt(id, pinned), board: slots([]) }) as SavedSearch;
    expect(homeBoards([b("a"), hunt("h"), b("c", true), b("d")]).map((s) => s.id)).toEqual(["c", "a", "d"]);
  });
});
