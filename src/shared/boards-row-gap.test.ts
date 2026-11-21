import { describe, expect, test } from "bun:test";
import { boardRowGaps, fitRow, type FitCell } from "./boards";

const cell = (id: string, view: FitCell["view"], x: number, y: number, w: number, h: number): FitCell => ({ id, view, x, y, w, h });

// The Ops board on logs.example.org (sheet 51, 51d → 51e).
const eleos: FitCell[] = [
  cell("u", "section", 0, 0, 12, 1),
  cell("v", "histogram", 0, 1, 5, 4),
  cell("w", "histogram", 5, 1, 5, 4),
  cell("x", "section", 0, 5, 12, 1),
  cell("y", "stat", 0, 6, 3, 2),
  cell("z", "stat", 3, 6, 3, 2),
  cell("a", "stat", 6, 6, 3, 2),
];

describe("Row-end room (51e)", () => {
  test("5 + 5 leaves 2 columns, 3 + 3 + 3 leaves 3", () => {
    expect(boardRowGaps(eleos)).toEqual([
      { y: 1, x: 10, w: 2, h: 4, ids: ["v", "w"] },
      { y: 6, x: 9, w: 3, h: 2, ids: ["y", "z", "a"] },
    ]);
  });

  test("a full row has none", () => {
    expect(boardRowGaps([cell("v", "histogram", 0, 0, 6, 4), cell("w", "histogram", 6, 0, 6, 4)])).toEqual([]);
  });

  test("1 column left over is not room", () => {
    expect(boardRowGaps([cell("v", "histogram", 0, 0, 11, 4)])).toEqual([]);
  });

  test("a tall panel from another row in the room leaves none", () => {
    const cells = [cell("t", "histogram", 8, 0, 4, 6), cell("v", "histogram", 0, 0, 8, 2), cell("w", "stat", 0, 2, 4, 2)];
    expect(boardRowGaps(cells)).toEqual([]);
  });

  test("a note in the room leaves none", () => {
    expect(boardRowGaps([cell("v", "histogram", 0, 0, 6, 4), cell("n", "note", 9, 0, 3, 2)])).toEqual([]);
  });

  test("headings and notes get no room of their own", () => {
    expect(boardRowGaps([cell("u", "section", 0, 0, 12, 1), cell("n", "note", 0, 1, 4, 2)])).toEqual([]);
  });

  test("Widen fits only its own row", () => {
    const fit = fitRow(eleos, 6);
    expect(fit.map((c) => [c.id, c.x, c.w])).toEqual([
      ["u", 0, 12],
      ["v", 0, 5],
      ["w", 5, 5],
      ["x", 0, 12],
      ["y", 0, 4],
      ["z", 4, 4],
      ["a", 8, 4],
    ]);
    expect(boardRowGaps(fit).map((gap) => gap.y)).toEqual([1]);
  });
});
