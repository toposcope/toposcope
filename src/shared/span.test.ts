import { describe, expect, test } from "bun:test";
import { pickSlowestBranches } from "./span";

describe("pickSlowestBranches", () => {
  test("keeps everything under the cap", () => {
    const keep = pickSlowestBranches(
      [
        { span_id: "a", parent_span_id: "", duration_ms: 10 },
        { span_id: "b", parent_span_id: "a", duration_ms: 4 },
      ],
      500,
    );
    expect([...keep].sort()).toEqual(["a", "b"]);
  });

  test("keeps ancestors of the slowest leaf", () => {
    const keep = pickSlowestBranches(
      [
        { span_id: "root", parent_span_id: "", duration_ms: 100 },
        { span_id: "fast", parent_span_id: "root", duration_ms: 1 },
        { span_id: "mid", parent_span_id: "root", duration_ms: 80 },
        { span_id: "slow", parent_span_id: "mid", duration_ms: 70 },
      ],
      3,
    );
    expect(keep.has("slow")).toBe(true);
    expect(keep.has("mid")).toBe(true);
    expect(keep.has("root")).toBe(true);
    expect(keep.has("fast")).toBe(false);
  });
});
