import { describe, expect, test } from "bun:test";
import { roleCards } from "./components/fields-view";

describe("Fields in the new header (#269, 26l)", () => {
  test("each role says what it changes", () => {
    expect(roleCards.map((c) => c.role)).toEqual(["chart", "lookup", "ignore"]);
    expect(roleCards[0]!.words).toContain("new rows only");
    expect(roleCards[1]!.words).toContain("never a facet");
  });
});
