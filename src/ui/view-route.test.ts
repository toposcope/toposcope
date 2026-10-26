import { describe, expect, test } from "bun:test";
import { defaultSearchUrlState, serializeSearchUrl, parseOperatorView, parseSearchUrl } from "./search-url";

// #258: every page is `?view=`; no `view` is the hunt; the 0.5 `alerts` link still lands on Watch.
describe("view routing", () => {
  test("parses every page and falls back to the hunt", () => {
    expect(parseOperatorView(null)).toBe("search");
    expect(parseOperatorView("search")).toBe("search");
    expect(parseOperatorView("nonsense")).toBe("search");
    for (const v of ["home", "watch", "fields", "links", "access"] as const) {
      expect(parseOperatorView(v)).toBe(v);
    }
    expect(parseOperatorView("alerts")).toBe("watch");
  });

  test("writes view for every page but the hunt", () => {
    const state = defaultSearchUrlState();
    expect(serializeSearchUrl({ ...state, view: "search" })).not.toContain("view=");
    expect(serializeSearchUrl({ ...state, view: "home" })).toContain("view=home");
    expect(serializeSearchUrl({ ...state, view: "access" })).toContain("view=access");
    expect(parseSearchUrl("?view=access").view).toBe("access");
  });
});
