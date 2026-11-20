import { describe, expect, test } from "bun:test";
import { addPanelInSection, boardSections, countedPanels, panelMinW, panelSection, parseBoard, placeAtSectionEnd, updatePanelInSection } from "./boards";
import { gravity, widenCells } from "./grid-gravity";
import { defaultTimeseries } from "./widgets";

/** Eleos as 49c draws it: Graphs with two Volume panels, Metrics with three Number panels 1 column wide. */
function eleos() {
  return parseBoard({
    panels: [
      { id: "u", name: "Graphs", view: "section", widget: { x: 0, y: 0, w: 12, h: 1 } },
      { id: "v", name: "incus", q: "service:incus", view: "histogram", widget: { x: 0, y: 1, w: 6, h: 4 } },
      { id: "w", name: "All logs", view: "histogram", widget: { x: 6, y: 1, w: 6, h: 4 } },
      { id: "x", name: "Metrics", view: "section", widget: { x: 0, y: 5, w: 12, h: 1 } },
      { id: "y", name: "Call duration", view: "stat", widget: { x: 0, y: 6, w: 1, h: 2 } },
      { id: "z", name: "incus rate", view: "stat", widget: { x: 1, y: 6, w: 1, h: 2 } },
      { id: "a", name: "incus warn rate", view: "stat", widget: { x: 2, y: 6, w: 1, h: 2 } },
      { id: "b", name: "On call", view: "note", widget: { x: 0, y: 8, w: 1, h: 2 } },
    ],
  })!;
}

describe("the board head's count (49d)", () => {
  test("counts panels that read rows, not headings or notes", () => {
    expect(countedPanels(eleos().panels)).toBe(5);
    expect(countedPanels([])).toBe(0);
  });
});

describe("a Number panel's least width (49d)", () => {
  test("is 3 of 12 columns; a note keeps 1 and a Volume 4", () => {
    expect([panelMinW("stat"), panelMinW("note"), panelMinW("histogram"), panelMinW("top")]).toEqual([3, 1, 4, 3]);
  });

  test("three Number panels 1 column wide draw 3 wide side by side, and nothing overlaps", () => {
    const board = eleos();
    const cells = board.panels.map((p) => ({ id: p.id, view: p.view, x: p.widget.x, y: p.widget.y, w: p.widget.w, h: p.widget.h }));
    const drawn = gravity(widenCells(cells, (c) => panelMinW(c.view)));
    const at = (id: string) => drawn.find((c) => c.id === id)!;
    expect([at("y"), at("z"), at("a")].map((c) => [c.x, c.y, c.w])).toEqual([
      [0, 6, 3],
      [3, 6, 3],
      [6, 6, 3],
    ]);
    // The others keep their sizes; the note stays 1 wide.
    expect([at("v").w, at("w").w, at("b").w]).toEqual([6, 6, 1]);
    for (const a of drawn) {
      for (const b of drawn) {
        if (a !== b) {
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
        }
      }
    }
  });

  test("a narrow panel at the right edge widens to the left", () => {
    const [cell] = widenCells([{ id: "s", x: 11, y: 0, w: 1, h: 2 }], () => 3);
    expect([cell!.x, cell!.w]).toEqual([9, 3]);
  });

  test("with nothing to widen, the cells come back as they were", () => {
    const cells = [{ id: "s", x: 0, y: 0, w: 4, h: 2 }];
    expect(widenCells(cells, () => 3)).toBe(cells);
  });

  test("a widened panel with no room beside it goes down", () => {
    const cells = [
      { id: "s", x: 0, y: 0, w: 1, h: 2 },
      { id: "t", x: 1, y: 0, w: 11, h: 2 },
    ];
    const drawn = gravity(widenCells(cells, (c) => (c.id === "s" ? 3 : 1)));
    expect(drawn.map((c) => [c.id, c.x, c.y, c.w])).toEqual([
      ["s", 0, 0, 3],
      ["t", 1, 2, 11],
    ]);
  });
});

describe("the panel sheet's Section (49f)", () => {
  test("lists headings top to bottom, and a panel's section is the heading above it", () => {
    const board = eleos();
    expect(boardSections(board.panels)).toEqual([
      { id: "u", name: "Graphs" },
      { id: "x", name: "Metrics" },
    ]);
    expect([panelSection(board.panels, "v"), panelSection(board.panels, "y"), panelSection(board.panels, "u")]).toEqual(["u", "x", null]);
  });

  test("a new panel goes beside the last row of its section (the note, here) when it fits", () => {
    const board = eleos();
    const { cell, panels } = placeAtSectionEnd(board.panels, "x", { w: 4, h: 2 });
    expect(cell).toEqual({ x: 1, y: 8, w: 4, h: 2 });
    expect(panels).toBe(board.panels);
  });

  test("with no room beside, it takes a new row and moves what is under it down", () => {
    const board = eleos();
    const { cell, panels } = placeAtSectionEnd(board.panels, "u", { w: 6, h: 4 });
    expect(cell).toEqual({ x: 0, y: 5, w: 6, h: 4 });
    const metrics = panels.find((p) => p.id === "x")!;
    expect(metrics.widget.y).toBe(9);
    expect(panels.find((p) => p.id === "v")!.widget.y).toBe(1);
  });

  test("an empty section takes it on the row under the heading", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "A", view: "section", widget: { x: 0, y: 0, w: 12, h: 1 } },
        { id: "v", name: "B", view: "section", widget: { x: 0, y: 1, w: 12, h: 1 } },
      ],
    })!;
    const { cell, panels } = placeAtSectionEnd(board.panels, "u", { w: 6, h: 4 });
    expect(cell).toEqual({ x: 0, y: 1, w: 6, h: 4 });
    expect(panels.find((p) => p.id === "v")!.widget.y).toBe(5);
  });

  test("no section is the part above the first heading; on a board with none, its end", () => {
    const board = parseBoard({ panels: [{ id: "u", view: "histogram", widget: { x: 0, y: 0, w: 12, h: 4 } }] })!;
    expect(placeAtSectionEnd(board.panels, null, { w: 4, h: 2 }).cell).toEqual({ x: 0, y: 4, w: 4, h: 2 });
    expect(placeAtSectionEnd(eleos().panels, null, { w: 4, h: 2 }).cell).toEqual({ x: 0, y: 0, w: 4, h: 2 });
  });

  test("Add panel names an unnamed panel for what it reads and keeps a fixed window", () => {
    const board = eleos();
    const next = addPanelInSection(board, { name: " ", q: " service:api ", view: "histogram", widget: defaultTimeseries({ id: "b", w: 6, h: 4 }), fixed: "4h" }, "x")!;
    const added = next.panels.at(-1)!;
    expect([added.id, added.name, added.q, added.fixed, added.widget.x, added.widget.y, added.widget.w]).toEqual(["c", "Volume", "service:api", "4h", 1, 8, 6]);
  });

  test("Update panel keeps its cell in its section, and moves to the end of another", () => {
    const board = eleos();
    const v = board.panels.find((p) => p.id === "v")!;
    const same = updatePanelInSection(board, "v", { name: "incus warnings", q: "service:incus level:warn", view: v.view, widget: v.widget, fixed: null }, "u");
    const kept = same.panels.find((p) => p.id === "v")!;
    expect([kept.name, kept.q, kept.widget.x, kept.widget.y]).toEqual(["incus warnings", "service:incus level:warn", 0, 1]);
    const moved = updatePanelInSection(board, "v", { name: "incus", q: "service:incus", view: v.view, widget: v.widget, fixed: null }, "x");
    expect(moved.panels.map((p) => p.id)).toEqual(board.panels.map((p) => p.id));
    expect(panelSection(moved.panels, "v")).toBe("x");
  });
});
