import { describe, expect, test } from "bun:test";
import { parseFacetOmitSelf } from "./facet-omit";

describe("parseFacetOmitSelf", () => {
  test("defaults to omitting the grouped field (sidebar)", () => {
    expect(parseFacetOmitSelf(undefined)).toBe(true);
    expect(parseFacetOmitSelf(null)).toBe(true);
    expect(parseFacetOmitSelf("")).toBe(true);
  });

  test("omit=0 keeps the full query (Top-N)", () => {
    expect(parseFacetOmitSelf("0")).toBe(false);
    expect(parseFacetOmitSelf("false")).toBe(false);
    expect(parseFacetOmitSelf("FALSE")).toBe(false);
  });

  test("any other value keeps sidebar omit", () => {
    expect(parseFacetOmitSelf("1")).toBe(true);
    expect(parseFacetOmitSelf("true")).toBe(true);
  });
});
