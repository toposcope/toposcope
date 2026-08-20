import { describe, expect, test } from "bun:test";
import {
  flattenAttrs,
  formatPromotedCols,
  isAttrIdent,
  parseAttrFacets,
  parsePromotedCols,
} from "./attrs";

describe("flattenAttrs", () => {
  test("stringifies primitives and keeps one object for JSON and map", () => {
    expect(
      flattenAttrs({ path: "/v1", status: 500, ok: true, nested: { a: 1 } }),
    ).toEqual({
      path: "/v1",
      status: "500",
      ok: "true",
      nested: '{"a":1}',
    });
  });

  test("lowercases keys, skips reserved and empty, caps at 50", () => {
    expect(flattenAttrs({ Path: "/x", level: "error", "": "n", skip: null })).toEqual({
      path: "/x",
    });
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      many[`k${i}`] = String(i);
    }
    expect(Object.keys(flattenAttrs(many))).toHaveLength(50);
  });
});

describe("isAttrIdent", () => {
  test("allows dotted OTLP keys and rejects reserved names", () => {
    expect(isAttrIdent("http.status_code")).toBe(true);
    expect(isAttrIdent("user_id")).toBe(true);
    expect(isAttrIdent("level")).toBe(false);
    expect(isAttrIdent("foo-bar")).toBe(false);
  });
});

describe("parseAttrFacets", () => {
  test("dedupes, lowercases, caps at 8, drops junk", () => {
    expect(parseAttrFacets("path,PATH,user_id,nope!,status")).toEqual([
      "path",
      "user_id",
      "status",
    ]);
    expect(parseAttrFacets("a,b,c,d,e,f,g,h,i")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(parseAttrFacets("")).toEqual([]);
  });
});

describe("parsePromotedCols", () => {
  test("dedupes, lowercases, caps at 3, drops core names and junk", () => {
    expect(parsePromotedCols("path,PATH,status,user_id,nope!")).toEqual([
      "path",
      "status",
      "user_id",
    ]);
    expect(parsePromotedCols(["Status", "path", "level", "host"])).toEqual([
      "status",
      "path",
    ]);
    expect(parsePromotedCols("")).toEqual([]);
    expect(parsePromotedCols(null)).toEqual([]);
    expect(formatPromotedCols(["path", "status"])).toBe("path,status");
    expect(formatPromotedCols([])).toBeNull();
  });
});
