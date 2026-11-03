import { describe, expect, test } from "bun:test";
import { addTextPanel, foldedPanelIds, formatBoard, parseBoard, sectionMembers } from "./boards";

describe("section headings and note panels (sheet 44)", () => {
  test("a heading is one full-width row and a note keeps its text, through a save", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "Checkout", view: "section", widget: { x: 3, y: 0, w: 4, h: 6 }, q: "level:error", fixed: "24h", folded: true },
        { id: "v", name: "On call", view: "note", widget: { x: 8, y: 1, w: 4, h: 2 }, text: "Page #payments. https://runbook.example/checkout" },
      ],
    })!;
    const back = parseBoard(formatBoard(board))!;
    const [heading, note] = back.panels;
    expect([heading!.view, heading!.widget.x, heading!.widget.w, heading!.widget.h, heading!.q, heading!.fixed, heading!.folded]).toEqual(["section", 0, 12, 1, "", null, true]);
    expect([note!.view, note!.text, note!.widget.w, note!.widget.h]).toEqual(["note", "Page #payments. https://runbook.example/checkout", 4, 2]);
  });

  test("a note's text is cut at 1000 characters", () => {
    const board = parseBoard({ panels: [{ view: "note", text: "x".repeat(1200) }] })!;
    expect(board.panels[0]!.text).toHaveLength(1000);
  });

  test("Add section and Add note go at the bottom", () => {
    let board = parseBoard({ panels: [{ id: "u", view: "stat", widget: { x: 0, y: 0, w: 4, h: 2 } }] })!;
    board = addTextPanel(board, "section")!;
    board = addTextPanel(board, "note")!;
    expect(board.panels.map((p) => [p.view, p.widget.x, p.widget.y, p.widget.w, p.widget.h])).toEqual([
      ["stat", 0, 0, 4, 2],
      ["section", 0, 2, 12, 1],
      ["note", 0, 3, 4, 2],
    ]);
  });

  test("a folded heading puts away the panels under it, down to the next heading", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "Checkout", view: "section", widget: { y: 0 }, folded: true },
        { id: "v", view: "stat", widget: { x: 0, y: 1, w: 4, h: 2 } },
        { id: "w", view: "stat", widget: { x: 4, y: 1, w: 4, h: 2 } },
        { id: "x", name: "Infra", view: "section", widget: { y: 3 } },
        { id: "y", view: "stat", widget: { x: 0, y: 4, w: 4, h: 2 } },
      ],
    })!;
    expect([...foldedPanelIds(board.panels)].sort()).toEqual(["v", "w"]);
    expect(sectionMembers(board.panels, "x").map((p) => p.id)).toEqual(["y"]);
  });
});
