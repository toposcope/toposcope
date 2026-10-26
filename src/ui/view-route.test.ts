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

// #260: the selected mark rides in the URL, so a link lands with the Compare fold open under it.
describe("mark= in the URL", () => {
  test("round-trips and is left out when no mark is selected", () => {
    const state = defaultSearchUrlState();
    expect(serializeSearchUrl({ ...state, mark: "mk_1" })).toContain("mark=mk_1");
    expect(serializeSearchUrl({ ...state, mark: null })).not.toContain("mark=");
    expect(parseSearchUrl("?mark=mk_1").mark).toBe("mk_1");
    expect(parseSearchUrl("").mark).toBeNull();
  });
});
