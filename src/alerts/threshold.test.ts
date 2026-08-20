import { describe, expect, test } from "bun:test";
import { parseThreshold } from "./threshold";

describe("parseThreshold", () => {
  test("keeps integers and allows a fractional rate", () => {
    expect(parseThreshold(1)).toBe(1);
    expect(parseThreshold(0.5)).toBe(0.5);
    expect(parseThreshold("800")).toBe(800);
  });

  test("rejects zero, negative, and junk", () => {
    expect(parseThreshold(0)).toEqual({ error: "threshold must be > 0" });
    expect(parseThreshold(-1)).toEqual({ error: "threshold must be > 0" });
    expect(parseThreshold("nope")).toEqual({ error: "threshold must be > 0" });
  });
});
