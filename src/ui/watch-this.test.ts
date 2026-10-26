import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { knownTargets, targetLabel, WatchThisSheet, watchThisName } from "./components/watch-this-sheet";

describe("Watch this (#264, 26h)", () => {
  test("the name says the hunt and the condition", () => {
    expect(watchThisName("Errors on billing", "service:billing", "at_least", 20)).toBe("Errors on billing above 20");
    expect(watchThisName(null, "message:login", "fewer_than", 10)).toBe("message:login below 10");
    expect(watchThisName(null, "  ", "at_least", 5)).toBe("All logs above 5");
    expect(watchThisName("Errors on billing", "", "at_least", 2, "share")).toBe("Errors on billing above 2%");
  });
  test("one sentence, where it sends, the plot, and Save and watch", () => {
    const html = renderToStaticMarkup(
      createElement(WatchThisSheet, { q: "service:billing", agg: null, savedName: null, savedId: null, savedRange: null, onSave: async () => {}, onCancel: () => {} }),
    );
    expect(html).toContain("Watch this hunt");
    expect(html).toContain("rows of this search");
    expect(html).toContain("at least");
    expect(html).toContain("fewer than");
    expect(html).toContain("% of all rows");
    expect(html).toContain("+ webhook");
    expect(html).toContain("Would have opened · last 24 h");
    expect(html).toContain("Save and watch");
    expect(html).toMatch(/disabled=""[^>]*title="A test call reads a saved hunt/);
  });
});

describe("Sends to, as checkboxes (#280, 26h)", () => {
  test("every URL a monitor already calls, once each, never default", () => {
    expect(
      knownTargets([
        { webhook_url: "https://ntfy.sh/ops" },
        { webhook_url: "https://ntfy.sh/ops", webhook_urls: ["default", "https://hooks.slack.com/x"] },
        { webhook_url: null },
      ]),
    ).toEqual(["https://ntfy.sh/ops", "https://hooks.slack.com/x"]);
    expect(targetLabel("http://127.0.0.1:9/unused")).toBe("127.0.0.1:9/unused");
    expect(targetLabel("https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX")).toBe("hooks.slack.com/se…XXXXXXXXXXXX");
  });
});
