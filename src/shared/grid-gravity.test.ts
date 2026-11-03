import { describe, expect, test } from "bun:test";
import { gravity, gravityMove, gravityResize, type GridCell } from "./grid-gravity";

const at = (cells: GridCell[]) => Object.fromEntries(cells.map((c) => [c.id, [c.x, c.y, c.w, c.h]]));
const board = (): GridCell[] => [
  { id: "a", x: 0, y: 0, w: 8, h: 4 },
  { id: "b", x: 8, y: 0, w: 4, h: 2 },
  { id: "c", x: 8, y: 2, w: 4, h: 2 },
  { id: "d", x: 0, y: 4, w: 6, h: 3 },
  { id: "e", x: 6, y: 4, w: 6, h: 3 },
];
const limits = { min: () => ({ w: 2, h: 2 }), maxH: 16 };

describe("gravity (sheet 44, E)", () => {
  test("a layout with holes floats up", () => {
    expect(at(gravity([{ id: "a", x: 0, y: 3, w: 6, h: 2 }, { id: "b", x: 6, y: 9, w: 6, h: 2 }]))).toEqual({
      a: [0, 0, 6, 2],
      b: [6, 0, 6, 2],
    });
  });

  test("a panel lands in the columns it is dropped on, under what is there", () => {
    // Drop d on e's cell: d keeps columns 6–11 and e goes under it.
    const next = at(gravityMove(board(), "d", 6, 4));
    expect(next.d).toEqual([6, 4, 6, 3]);
    expect(next.e).toEqual([6, 7, 6, 3]);
    // Dropped far below, c floats up to sit right under e.
    expect(at(gravityMove(board(), "c", 8, 9)).c).toEqual([8, 7, 4, 2]);
  });

  test("panels in the way go down and the rest floats up", () => {
    const next = at(gravityMove(board(), "d", 0, 0));
    expect(next.d).toEqual([0, 0, 6, 3]);
    expect(next.a).toEqual([0, 3, 8, 4]);
    expect(next.b).toEqual([8, 0, 4, 2]);
  });

  test("an anchored panel never moves and is never moved", () => {
    const anchored = new Set(["a"]);
    expect(gravityMove(board(), "a", 4, 4, anchored)).toEqual(board());
    expect(at(gravityMove(board(), "d", 0, 0, anchored)).d).toEqual([0, 4, 6, 3]);
  });

  test("right and bottom edges grow and push", () => {
    const next = at(gravityResize(board(), "a", "s", 0, 2, limits));
    expect(next.a).toEqual([0, 0, 8, 6]);
    expect(next.d).toEqual([0, 6, 6, 3]);
    expect(at(gravityResize(board(), "b", "s", 0, 30, limits)).b).toEqual([8, 0, 4, 16]);
  });

  test("the left edge trades width with the panel touching it", () => {
    const next = at(gravityResize(board(), "e", "w", -2, 0, limits));
    expect(next.e).toEqual([4, 4, 8, 3]);
    expect(next.d).toEqual([0, 4, 4, 3]);
  });

  test("with nothing touching, the left edge shrinks, or grows into empty columns", () => {
    expect(at(gravityResize(board(), "d", "w", 2, 0, limits)).d).toEqual([2, 4, 4, 3]);
    expect(at(gravityResize(board(), "d", "w", -2, 0, limits)).d).toEqual([0, 4, 6, 3]);
    const apart: GridCell[] = [{ id: "a", x: 0, y: 0, w: 4, h: 2 }, { id: "b", x: 7, y: 0, w: 5, h: 2 }];
    expect(at(gravityResize(apart, "b", "w", -3, 0, limits)).b).toEqual([4, 0, 8, 2]);
  });

  test("the top edge trades height with the panels above", () => {
    const next = at(gravityResize(board(), "c", "n", 0, -0, limits));
    expect(next.c).toEqual([8, 2, 4, 2]);
    const up = at(gravityResize([{ id: "b", x: 8, y: 0, w: 4, h: 4 }, { id: "c", x: 8, y: 4, w: 4, h: 2 }], "c", "n", 0, -1, limits));
    expect(up.b).toEqual([8, 0, 4, 3]);
    expect(up.c).toEqual([8, 3, 4, 3]);
  });

  test("sizes stay inside their limits", () => {
    expect(at(gravityResize(board(), "b", "e", 5, 0, limits)).b).toEqual([8, 0, 4, 2]);
    expect(at(gravityResize(board(), "b", "s", 0, -5, limits)).b).toEqual([8, 0, 4, 2]);
  });
});
