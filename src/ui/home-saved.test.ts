import { describe, expect, test } from "bun:test";
import type { HomeCard } from "../control/home-since";
import {
  archivedSaved,
  archivedText,
  beforeAfterWidths,
  boardCountText,
  boardCounts,
  boardPreview,
  cardMoved,
  coverageLead,
  goneInQuiet,
  goneSince,
  goneText,
  sparkRows,
  drawsBeforeAfter,
  homeBoards,
  homeHunts,
  quietNotZero,
  quietText,
  quietValue,
  splitHunts,
} from "./home-saved";
import type { Coverage, CoverageService } from "../shared/coverage";
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

describe("archived hunts and boards (sheet 50)", () => {
  const empty = { keys: [], panels: [] };
  const archived = (id: string, board = false) => ({ ...hunt(id), archived: true, ...(board ? { board: empty } : {}) }) as SavedSearch;
  const b = (id: string) => ({ ...hunt(id), board: empty }) as SavedSearch;

  test("Home reads neither archived hunts nor archived boards", () => {
    const saved = [hunt("h1"), archived("h2"), b("b1"), archived("b2", true), hunt("h3")];
    expect(homeHunts(saved).map((s) => s.id)).toEqual(["h1", "h3"]);
    expect(homeBoards(saved).map((s) => s.id)).toEqual(["b1"]);
    expect(archivedSaved(saved).map((s) => s.id)).toEqual(["h2", "b2"]);
  });

  test("the Archived line counts hunts, and boards when there are any", () => {
    expect(archivedText(Array.from({ length: 20 }, (_, i) => archived(`h${i}`)))).toBe("20 saved hunts, not read on Home");
    expect(archivedText([archived("h")])).toBe("1 saved hunt, not read on Home");
    expect(archivedText([archived("h"), archived("b", true)])).toBe("1 saved hunt and 1 board, not read on Home");
    expect(archivedText([archived("b", true), archived("c", true)])).toBe("2 boards, not read on Home");
  });
});

describe("Quiet folded to a line (50b)", () => {
  test("the count, and the hunts not at zero, largest first", () => {
    expect(quietText(31)).toBe("31 saved hunts, same as before");
    expect(quietText(1)).toBe("1 saved hunt, same as before");
    const named = (id: string) => ({ id, name: id }) as SavedSearch;
    const quiet = [named("CI out of burst budget"), named("API event loop stalls"), named("Nightly job silent"), named("Refused"), named("Unread")];
    const cards = [card("CI out of burst budget", 0, 0), card("API event loop stalls", 13, 13), card("Nightly job silent", 27, 27), card("Refused", null, null, "scan budget")];
    expect(quietNotZero(quiet, cards)).toBe("2 not zero: Nightly job silent 27 · API event loop stalls 13");
  });

  test("three by name, then +N; none off zero, no text", () => {
    const quiet = ["a", "b", "c", "d", "e"].map((id) => ({ id, name: id }) as SavedSearch);
    const cards = [card("a", 1, 1), card("b", 5, 5), card("c", 3, 3), card("d", 4, 4), card("e", 2, 2)];
    expect(quietNotZero(quiet, cards)).toBe("5 not zero: b 5 · d 4 · c 3 +2");
    expect(quietNotZero(quiet, [card("a", 0, 0)])).toBeNull();
    expect(quietNotZero([], [])).toBeNull();
  });

  test("a row's value: refused, a compact count, or nothing when not read", () => {
    expect(quietValue(undefined)).toBe("");
    expect(quietValue(card("a", 0, 0, "scan budget"))).toBe("refused");
    expect(quietValue(card("a", 12_400, 12_400))).toBe("12.4K");
  });
});

describe("a Moved card's before and after (50b)", () => {
  test("fewer than four buckets with any value draw two bars", () => {
    expect(drawsBeforeAfter({ spark: [] })).toBe(true);
    expect(drawsBeforeAfter({ spark: [0, 0, 2, 0, 0, 1] })).toBe(true);
    expect(drawsBeforeAfter({ spark: [1, 0, 2, 3, 0] })).toBe(true);
    expect(drawsBeforeAfter({ spark: [1, 1, 2, 3] })).toBe(false);
  });

  test("the bars' lengths are was and now against the larger", () => {
    expect(beforeAfterWidths(0, 2)).toEqual({ before: 0, after: 100 });
    expect(beforeAfterWidths(2, 1)).toEqual({ before: 100, after: 50 });
    expect(beforeAfterWidths(null, null)).toEqual({ before: 0, after: 0 });
  });
});

describe("the Coverage line (50b)", () => {
  const service = (name: string, complete: boolean): CoverageService => ({
    service: name,
    rows: 100,
    errors: 0,
    version: complete ? 1 : 0,
    host: 1,
    trace_id: null,
    stack: null,
    marks: { count: complete ? 1 : 0, last: null },
    complete,
  });
  const coverage = (services: CoverageService[]): Coverage => ({ from: "", to: "", threshold: 0.95, services, complete: services.filter((s) => s.complete).length, mismatches: [] });

  test("services with gaps of all; no gaps, no line", () => {
    const lead = coverageLead(coverage(Array.from({ length: 10 }, (_, i) => service(`s${i}`, false))), null);
    expect(lead?.text.startsWith("s0: ")).toBe(true);
    expect(lead?.more).toBe(9);
    expect(coverageLead(coverage([service("a", false), service("b", true)]), null)?.more).toBe(0);
    expect(coverageLead(coverage([service("a", true)]), null)).toBeNull();
    expect(coverageLead(null, null)).toBeNull();
  });
});

describe("Quiet's gone hosts and Moved rows (sheet 51b)", () => {
  test("gone hunts keep Quiet's order", () => {
    expect(goneInQuiet([hunt("a"), hunt("b"), hunt("c")], ["c", "a", "z"]).map((s) => s.id)).toEqual(["a", "c"]);
    expect(goneText(18)).toBe("18 saved hunts read hosts that sent nothing in 7 days");
    expect(goneText(1)).toBe("1 saved hunt reads hosts that sent nothing in 7 days");
    expect(goneSince("2026-11-03T10:00:00.000Z")).toBe("since 11-03");
    expect(goneSince(null)).toBe("nothing kept");
  });

  test("spark rows split at the mark against one peak", () => {
    expect(sparkRows([5, 10, 20, 0], 2)).toEqual({ before: [25, 50], after: [100, 4] });
    expect(sparkRows([], 0)).toEqual({ before: [], after: [] });
  });
});
