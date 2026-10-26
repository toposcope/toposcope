import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchThisSheet, watchThisName } from "./components/watch-this-sheet";

describe("Watch this (#264, 26h)", () => {
  test("the name says the hunt and the condition", () => {
    expect(watchThisName("Errors on billing", "service:billing", "at_least", 20)).toBe("Errors on billing above 20");
    expect(watchThisName(null, "message:login", "fewer_than", 10)).toBe("message:login below 10");
    expect(watchThisName(null, "  ", "at_least", 5)).toBe("All logs above 5");
  });
  test("one sentence, where it sends, the plot, and Save and watch", () => {
    const html = renderToStaticMarkup(
      createElement(WatchThisSheet, { q: "service:billing", agg: null, savedName: null, savedId: null, savedRange: null, onSave: async () => {}, onCancel: () => {} }),
    );
    expect(html).toContain("Watch this hunt");
    expect(html).toContain("rows of this search");
    expect(html).toContain("at least");
    expect(html).toContain("fewer than");
    expect(html).toContain("its own URL");
    expect(html).toContain("Would have opened · last 24 h");
    expect(html).toContain("Save and watch");
    expect(html).toMatch(/disabled=""[^>]*title="A test call reads a saved hunt/);
  });
});
