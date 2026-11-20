import { describe, expect, test } from "bun:test";
import { fitPanelsToWidth, parseBoard, shareColumns, type BoardSlots } from "./boards";

const cells = (board: BoardSlots) => Object.fromEntries(board.panels.map((p) => [p.id, [p.widget.x, p.widget.y, p.widget.w, p.widget.h]]));

// The Eleos board on logs.agental.io (sheet 50, 50d → 50e).
const eleos = parseBoard({
  panels: [
    { id: "u", name: "Graphs", view: "section", widget: { x: 0, y: 0, w: 12, h: 1 } },
    { id: "v", name: "Volume", q: "service:agental", view: "histogram", widget: { x: 0, y: 1, w: 5, h: 4 } },
    { id: "w", name: "Volume", q: "", view: "histogram", widget: { x: 5, y: 1, w: 5, h: 4 } },
    { id: "x", name: "Metrics", view: "section", widget: { x: 0, y: 5, w: 12, h: 1 } },
    { id: "y", name: "rate", q: "service:incus", view: "stat", widget: { x: 0, y: 6, w: 3, h: 2, agg: "sum:agental.call.duration" } },
    { id: "z", name: "rate", q: "service:incus", view: "stat", widget: { x: 3, y: 6, w: 3, h: 2, agg: "rate" } },
    { id: "a", name: "rate", q: "service:incus level:warn", view: "stat", widget: { x: 6, y: 6, w: 3, h: 2, agg: "rate" } },
  ],
})!;

describe("Fit panels to the width (50e)", () => {
  test("Eleos: two 5-column panels become 6 + 6, three 3-column panels 4 + 4 + 4", () => {
    const fit = fitPanelsToWidth(eleos);
    expect(cells(fit)).toEqual({
      u: [0, 0, 12, 1],
      v: [0, 1, 6, 4],
      w: [6, 1, 6, 4],
      x: [0, 5, 12, 1],
      y: [0, 6, 4, 2],
      z: [4, 6, 4, 2],
      a: [8, 6, 4, 2],
    });
    // Order, names, queries and views are kept; only cells change.
    expect(fit.panels.map((p) => [p.id, p.name, p.q, p.view])).toEqual(eleos.panels.map((p) => [p.id, p.name, p.q, p.view]));
  });

  test("a board that already fills the width comes back as it was", () => {
    const fit = fitPanelsToWidth(eleos);
    expect(fitPanelsToWidth(fit)).toBe(fit);
  });

  test("widths share in proportion, and a gap at the start is taken", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "a", view: "histogram", widget: { x: 2, y: 0, w: 4, h: 4 } },
        { id: "v", name: "b", view: "stat", widget: { x: 6, y: 0, w: 3, h: 2 } },
      ],
    })!;
    expect(cells(fitPanelsToWidth(board))).toEqual({ u: [0, 0, 7, 4], v: [7, 0, 5, 2] });
  });

  test("a note keeps its cell, and the panels beside it share what is left", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "a", view: "histogram", widget: { x: 0, y: 0, w: 4, h: 4 } },
        { id: "v", name: "Note", view: "note", widget: { x: 9, y: 0, w: 3, h: 2 }, text: "read me" },
      ],
    })!;
    expect(cells(fitPanelsToWidth(board))).toEqual({ u: [0, 0, 9, 4], v: [9, 0, 3, 2] });
  });

  test("a taller panel from the row above keeps its columns", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "tall", view: "histogram", widget: { x: 0, y: 0, w: 6, h: 6 } },
        { id: "v", name: "a", view: "stat", widget: { x: 6, y: 0, w: 6, h: 2 } },
        { id: "w", name: "b", view: "stat", widget: { x: 6, y: 2, w: 3, h: 2 } },
      ],
    })!;
    const fit = cells(fitPanelsToWidth(board));
    expect([fit.u, fit.v]).toEqual([[0, 0, 6, 6], [6, 0, 6, 2]]);
    expect([fit.w![0], fit.w![2]]).toEqual([6, 6]);
  });

  test("the panels of one row share it in proportion, tall or not", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "tall", view: "histogram", widget: { x: 0, y: 0, w: 6, h: 6 } },
        { id: "v", name: "a", view: "stat", widget: { x: 6, y: 0, w: 3, h: 2 } },
      ],
    })!;
    const fit = cells(fitPanelsToWidth(board));
    expect([fit.u![0], fit.u![2], fit.v![0], fit.v![2]]).toEqual([0, 8, 8, 4]);
  });

  test("a panel that grew onto one below pushes it down", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "a", view: "histogram", widget: { x: 0, y: 0, w: 4, h: 6 } },
        { id: "v", name: "b", view: "histogram", widget: { x: 4, y: 0, w: 4, h: 3 } },
        { id: "w", name: "c", view: "stat", widget: { x: 4, y: 3, w: 8, h: 2 } },
      ],
    })!;
    const fit = cells(fitPanelsToWidth(board));
    expect(fit.u).toEqual([0, 0, 6, 6]);
    expect(fit.v).toEqual([6, 0, 6, 3]);
    // c sat beside a, from column 4; a now holds columns 0–5 there, so c goes under it.
    expect(fit.w!.slice(0, 2)).toEqual([4, 6]);
  });

  test("a one-column Number panel is taken at its least width first", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "n", view: "stat", widget: { x: 0, y: 0, w: 1, h: 2 } },
        { id: "v", name: "m", view: "stat", widget: { x: 3, y: 0, w: 3, h: 2 } },
      ],
    })!;
    expect(cells(fitPanelsToWidth(board))).toEqual({ u: [0, 0, 6, 2], v: [6, 0, 6, 2] });
  });

  test("shareColumns keeps least widths and hands out what rounding leaves", () => {
    expect(shareColumns([5, 5], [4, 4], 12)).toEqual([6, 6]);
    expect(shareColumns([3, 3, 3], [3, 3, 3], 12)).toEqual([4, 4, 4]);
    expect(shareColumns([4, 3], [4, 3], 12)).toEqual([7, 5]);
    expect(shareColumns([1, 8], [3, 4], 12)).toEqual([3, 9]);
    expect(shareColumns([6, 6], [4, 4], 12)).toBeNull();
    expect(shareColumns([3, 3, 3, 3, 1], [3, 3, 3, 3, 3], 12)).toBeNull();
  });
});
