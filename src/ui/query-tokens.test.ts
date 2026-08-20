import { describe, expect, test } from "bun:test";
import {
  activeFacetValues,
  addFieldToken,
  excludeFieldToken,
  facetValues,
  formatFieldToken,
  hasExcludedFieldToken,
  hasFieldToken,
  queryFieldKeys,
  removeFieldToken,
  setFieldToken,
  stripSlotKeys,
  toggleFieldToken,
} from "./query-tokens";

describe("query tokens", () => {
  test("setFieldToken appends when the field is absent", () => {
    expect(setFieldToken("timeout", "level", "error")).toBe("timeout level:error");
    expect(setFieldToken("", "service", "api")).toBe("service:api");
  });

  test("setFieldToken replaces an existing field", () => {
    expect(setFieldToken("level:warn timeout", "level", "error")).toBe(
      "timeout level:error",
    );
  });

  test("removeFieldToken drops every token for that field", () => {
    expect(removeFieldToken("level:error service:api timeout", "level")).toBe(
      "service:api timeout",
    );
  });

  test("toggleFieldToken adds a second value as a parenthesised OR", () => {
    expect(toggleFieldToken("level:error timeout", "level", "error")).toBe(
      "timeout",
    );
    expect(toggleFieldToken("level:error timeout", "level", "warn")).toBe(
      "timeout (level:error OR level:warn)",
    );
  });

  test("facetValues reads a typed OR group and ignores bare AND", () => {
    expect(facetValues("(level:error OR level:fatal) service:api", "level")).toEqual(
      ["error", "fatal"],
    );
    expect(facetValues("level:error OR level:fatal", "level")).toEqual([
      "error",
      "fatal",
    ]);
    expect(facetValues("level:error", "level")).toEqual(["error"]);
    expect(facetValues("level:error level:fatal", "level")).toEqual([]);
    expect(facetValues("level:error OR level:fatal service:api", "level")).toEqual(
      [],
    );
  });

  test("activeFacetValues skips a bare AND of the same field", () => {
    expect(
      activeFacetValues("(level:error OR level:fatal) service:api", [
        "level",
        "service",
        "host",
      ]),
    ).toEqual({
      level: ["error", "fatal"],
      service: ["api"],
    });
    expect(activeFacetValues("level:error level:fatal", ["level"])).toEqual({});
  });

  test("hasFieldToken sees values inside an OR group", () => {
    expect(hasFieldToken("(level:error OR level:fatal)", "level", "fatal")).toBe(
      true,
    );
    expect(hasFieldToken("  Level:Error  ", "level", "error")).toBe(true);
    expect(hasFieldToken("level:error", "service", "api")).toBe(false);
  });

  test("setFieldToken wraps a top-level OR in parens", () => {
    expect(setFieldToken("level:error OR level:fatal", "service", "api")).toBe(
      "(level:error OR level:fatal) service:api",
    );
  });

  test("setFieldToken collapses an OR of the same field", () => {
    expect(setFieldToken("level:error OR level:fatal", "level", "warn")).toBe(
      "level:warn",
    );
  });

  test("addFieldToken ORs into an existing value", () => {
    expect(addFieldToken("level:error", "level", "fatal")).toBe(
      "(level:error OR level:fatal)",
    );
    expect(addFieldToken("(level:error OR level:fatal)", "level", "error")).toBe(
      "(level:error OR level:fatal)",
    );
  });

  test("excludeFieldToken adds a minus token and drops the positive", () => {
    expect(excludeFieldToken("", "level", "error")).toBe("-level:error");
    expect(excludeFieldToken("level:error timeout", "level", "error")).toBe(
      "timeout -level:error",
    );
    expect(excludeFieldToken("service:api", "level", "error")).toBe(
      "service:api -level:error",
    );
    expect(excludeFieldToken("level:error OR level:fatal", "service", "api")).toBe(
      "(level:error OR level:fatal) -service:api",
    );
  });

  test("only and clear rewrite the field set", () => {
    expect(setFieldToken("(level:error OR level:fatal) service:api", "level", "error")).toBe(
      "service:api level:error",
    );
    expect(removeFieldToken("(level:error OR level:fatal) service:api", "level")).toBe(
      "service:api",
    );
  });

  test("excludeFieldToken is a no-op when already excluded", () => {
    expect(excludeFieldToken("-level:error", "level", "error")).toBe(
      "-level:error",
    );
    expect(hasExcludedFieldToken("-level:error", "level", "error")).toBe(true);
    expect(formatFieldToken("path", "/v1/a b")).toBe('path:"/v1/a b"');
  });

  test("quoted values stay one token", () => {
    expect(setFieldToken('path:"/v1/items"', "path", "/v1/other")).toBe(
      "path:/v1/other",
    );
    expect(hasFieldToken('path:"/v1/a b"', "path", "/v1/a b")).toBe(true);
  });

  test("facet replace still writes equality over a comparison token", () => {
    expect(setFieldToken("duration_ms:>100 service:api", "duration_ms", "84")).toBe(
      "service:api duration_ms:84",
    );
  });

  test("queryFieldKeys lists keys this query contains", () => {
    expect(queryFieldKeys("level:warn install_name:acme-eu status:4*")).toEqual([
      "level",
      "install_name",
      "status",
    ]);
    expect(queryFieldKeys("-status:200 timeout")).toEqual(["status"]);
  });

  test("stripSlotKeys lifts slotted tokens out of the stored query", () => {
    expect(
      stripSlotKeys("level:warn install_name:acme-eu status:4*", ["install_name"]),
    ).toBe("level:warn status:4*");
  });
});
