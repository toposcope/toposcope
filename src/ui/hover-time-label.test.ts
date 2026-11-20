import { describe, expect, test } from "bun:test";
import { markLabelSide } from "./hover-time";

describe("mark hover label", () => {
  test("opens away from the nearer edge", () => {
    expect(markLabelSide(10, 0, 100)).toBe("right");
    expect(markLabelSide(90, 0, 100)).toBe("left");
    expect(markLabelSide(5, 0, 0)).toBe("right");
  });
});
