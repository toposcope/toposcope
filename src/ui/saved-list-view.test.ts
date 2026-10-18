import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedList } from "./components/saved-list";
import type { AlertRule, SavedSearch } from "./types";

// #168: what Saved draws, frame by frame (16b, 16c, 16k).
let next = 0;
const saved = (name: string, extra: Partial<SavedSearch> = {}): SavedSearch => ({
  id: `s${++next}`,
  name,
  query: "level:error",
  from_ts: null,
  to_ts: null,
  range: "1h",
  created_at: 1000 - next,
  ...extra,
});
const noop = () => {};

function draw(items: SavedSearch[], alerts: AlertRule[] = [], counts: Record<string, number> = {}): string {
  return renderToStaticMarkup(
    createElement(SavedList, {
      saved: items,
      alerts,
      counts,
      activeSavedId: null,
      homeId: null,
      elsewhere: {},
      onApplySaved: noop,
      onTest: noop,
      onAlert: noop,
      onSetHome: noop,
      onDeleteSaved: noop,
    }),
  );
}

const agental = [
  ...["sandbox boot failures", "new fingerprints after a deploy", "threshold breaches on any box", "box does not report", "database errors", "box compile timeouts", "API errors"].map((rest) => saved(`agental alert: ${rest}`)),
  ...["box hours by plan", "box hours by region", "box hours by customer", "box ended · vCPU", "box ended · memory", "box ended · disk", "all boxes · vCPU", "all boxes · memory", "all boxes · disk"].map((rest) => saved(`agental stranded: ${rest}`)),
  ...["disk", "memory", "cpu"].map((rest) => saved(`agental shapes: ${rest}`)),
  ...["control server load", "capacity, max boxes per host", "sandboxes per hour"].map((rest) => saved(`agental fleet: ${rest}`)),
];
const watchedBy = (items: SavedSearch[]) =>
  items.map((item) => ({ id: `a-${item.id}`, name: item.name, kind: "threshold", saved_search_id: item.id, threshold: 5 }) as AlertRule);

describe("Saved with agental's 22", () => {
  const html = draw(agental, watchedBy(agental.slice(0, 7)));

  test("a filter and the kind buttons sit at the top", () => {
    expect(html).toContain('aria-label="Filter saved searches by name"');
    expect(html).toContain('placeholder="Filter 22 by name"');
    expect(html).toContain('aria-label="Only the 7 an alert watches"');
  });

  test("past 20, the four groups start closed, named by their shared words and counted", () => {
    expect(html.match(/aria-expanded="false"[^>]*>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    for (const [prefix, n] of [["agental alert", 7], ["agental stranded", 9], ["agental shapes", 3], ["agental fleet", 3]] as const) {
      expect(html).toContain(`>${prefix}</span>`);
      expect(html).toMatch(new RegExp(`>${prefix}</span>.*?>${n}</span></button>`));
    }
    // Closed: no row of a group is drawn.
    expect(html).not.toContain("box ended · vCPU");
  });
});

describe("Saved with three", () => {
  const three = [saved("Prod 5xx"), saved("Checkout errors"), saved("Slow queries > 1s")];
  const html = draw(three, [], { [three[0]!.id]: 31_600 });

  test("no filter, no group, and no kind column (16k)", () => {
    expect(html).not.toContain("Filter saved searches");
    expect(html).not.toContain("aria-expanded=\"true\"");
    expect(html).not.toContain("h-4 w-3 shrink-0");
    expect(html).toContain(">Prod 5xx<");
  });
});

describe("Saved with a group open", () => {
  const twelve = [...agental.slice(7, 16), saved("Checkout errors"), saved("Prod 5xx"), saved("Ingest lag")];

  test("rows inside drop the shared words; searches outside a group come first (16b)", () => {
    const html = draw(twelve);
    expect(html).toContain(">box ended · vCPU<");
    expect(html).not.toContain(">agental stranded: box ended · vCPU<");
    expect(html.indexOf("Checkout errors")).toBeLessThan(html.indexOf("agental stranded"));
  });
});
