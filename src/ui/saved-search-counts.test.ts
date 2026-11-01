import { describe, expect, test } from "bun:test";
import { SAVED_COUNT_REFRESH_MS } from "./saved-search-counts";

const appSource = await Bun.file(new URL("./App.tsx", import.meta.url)).text();

/** The replace-search success arm that stamps lastMs, then currently refreshes saved-search counts. */
function replaceSearchSuccessArm(src: string): string {
  const start = src.indexOf("setLastMs(Date.now() - started);");
  if (start < 0) {
    throw new Error("replace-search lastMs stamp missing");
  }
  // The arm ends where the replace hands the chip and picker lists to the Live refresh registry.
  const end = src.indexOf("liveRefresh.runNow(sidebarRefreshKeys);", start);
  if (end < 0) {
    throw new Error("replace-search facet refresh missing");
  }
  return src.slice(start, end);
}

function replaceSearchRunRequests(src: string, savedSearchCount: number): number {
  return replaceSearchSuccessArm(src).includes("loadCounts")
    ? savedSearchCount
    : 0;
}

describe("saved-search count fan-out", () => {
  test("a replace search does not re-run every saved search", () => {
    expect(replaceSearchSuccessArm(appSource)).not.toContain("loadCounts");
  });

  test("adding saved searches does not add /run requests to a replace search", () => {
    expect(replaceSearchRunRequests(appSource, 1)).toBe(0);
    expect(replaceSearchRunRequests(appSource, 10)).toBe(0);
  });

  test("the hunt reads no per-saved-search counts: Home reads its own, every 30 s (#260)", () => {
    expect(SAVED_COUNT_REFRESH_MS).toBe(30_000);
    expect(appSource).not.toContain("loadCounts(");
    expect(appSource).not.toContain("loadSavedCounts");
  });
});
