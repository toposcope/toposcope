import { describe, expect, test } from "bun:test";
import { isArrowKey, stepIndex } from "./keyboard";

describe("stepIndex", () => {
  test("clamps at the ends", () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
  });
});

describe("isArrowKey", () => {
  test("only the four arrows", () => {
    expect(isArrowKey("ArrowLeft")).toBe(true);
    expect(isArrowKey("Enter")).toBe(false);
    expect(isArrowKey("j")).toBe(false);
  });
});
