import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { firstSeenMarksScope, thresholdSentence } from "./alert-condition";
import { AlertsView } from "./components/alerts-view";
import type { AlertRule, SavedSearch } from "./types";

describe("the alert dialog's words (#107, frames 15e and 15f)", () => {
  test("a threshold alert says what pages and how long it waits", () => {
    expect(thresholdSentence({ name: "api p99 slow", agg: "p99:duration_ms", range: "15m" }, "800")).toBe(
      "Pages when api p99 slow’s p99(duration_ms) over its 15m is at or above 800, then waits 15m before it can page again.",
    );
    expect(thresholdSentence({ name: "webhook failures", agg: null, range: null }, "5")).toContain(
      "over its window is at or above 5, then waits 5m",
    );
  });

  test("the marks a first-seen alert watches, as its q scopes them", () => {
    expect(firstSeenMarksScope("level:error service:api")).toBe("on service api, or on no service");
    expect(firstSeenMarksScope("(service:api OR service:web) level:error")).toBe(
      "on service api or web, or on no service",
    );
    expect(firstSeenMarksScope("level:error")).toBe("on any service");
  });
});

const base: AlertRule = {
  id: "r",
  name: "",
  kind: "threshold",
  last_mark: null,
  saved_search_id: "s1",
  threshold: 1,
  webhook_url: "https://api.pushover.net/1/messages.json",
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
};

const saved = [{ id: "s1", name: "api errors", query: "level:error service:api", agg: null }] as unknown as SavedSearch[];

function render(alerts: AlertRule[]): string {
  return renderToStaticMarkup(
    createElement(AlertsView, {
      alerts,
      saved,
      series: {},
      onOpenSearch: () => {},
      onEdit: () => {},
      onCreate: () => {},
      onSilence: () => {},
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

describe("the Alerts list with both kinds (#107, frame 15k)", () => {
  test("a first-seen row: its kind, its threshold in words, the mark it last paged on", () => {
    const text = render([
      {
        ...base,
        id: "fp",
        name: "new bugs after a deploy",
        kind: "first_seen",
        last_fired_at: Date.parse("2026-10-16T10:43:11.000Z"),
        last_mark: { id: "mk", kind: "deploy", title: "v0.9.3", service: "api", ts: "2026-10-16T10:42:07.311Z", count: 2, at: 0 },
      },
    ]);
    expect(text).toContain("new bugs after a deploy new fingerprints");
    expect(text).toContain("≥ 1 event after a deploy or flag · 24h");
    expect(text).toContain("deploy v0.9.3 · 10:42 · 2 fingerprints");
    expect(text).toContain("paged 2026-10-16 10:43Z");
  });

  test("a refused cut is said under Last fired, not as a webhook failure", () => {
    const text = render([
      {
        ...base,
        id: "fp2",
        name: "box errors after a change",
        kind: "first_seen",
        last_status: "refused",
        last_error: "more than 200 fingerprints on a side after flag: scaler.v2 · 11:58",
      },
    ]);
    expect(text).toContain("new fingerprints refused");
    expect(text).toContain("refused: more than 200 fingerprints on a side after flag: scaler.v2 · 11:58");
    expect(text.match(/refused/g)?.length).toBe(2);
  });

  test("a threshold row says threshold and keeps its value", () => {
    const text = render([{ ...base, id: "t", name: "api p99 slow", threshold: 800 }]);
    expect(text).toContain("api p99 slow threshold");
    expect(text).toContain("/ 800");
  });
});
