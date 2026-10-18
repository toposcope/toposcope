import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperatorSidebar } from "./components/operator-sidebar";
import type { SavedSearch } from "./types";

// A board's sidebar count read 0: `GET /api/saved-searches/:id/run` refuses a board (400),
// and the sidebar showed any failed run as 0, which reads as an empty search.
const board: SavedSearch = {
  id: "b1",
  name: "fleet · box",
  query: "service:box",
  from_ts: null,
  to_ts: null,
  range: "1h",
  board: { keys: ["host"], win: false },
  created_at: 1,
};
const plain: SavedSearch = { ...board, id: "p1", name: "box commands", board: null };

const noop = () => {};

function sidebar(counts: Record<string, number>): string {
  const props = {
    saved: [board, plain],
    alerts: [],
    counts,
    activeSavedId: null,
    elsewhere: {},
    facets: { level: [], service: [], host: [] },
    activeFacets: {},
    facetsLoading: false,
    attrPins: [],
    attrFacetValues: {},
    attrFacetsLoading: false,
    attrPrefixes: {},
    attrKeys: [],
    attrKeysLoading: false,
    onToggleFacet: noop,
    onOnlyFacet: noop,
    onClearFacet: noop,
    onAddAttrFacet: noop,
    onRemoveAttrFacet: noop,
    onAttrPrefix: noop,
    onOpenAddFacet: noop,
    onApplySaved: noop,
    onTest: noop,
    onAlert: noop,
    onDeleteSaved: noop,
  };
  return renderToStaticMarkup(createElement(OperatorSidebar, props as never));
}

describe("a board's sidebar count", () => {
  test("is not read from a refused run, so it is not 0", async () => {
    // The run route answers a board with 400, as it does today.
    const fetchRun = async (url: string) =>
      url.includes("/b1/")
        ? Response.json({ error: "Boards cannot be watched" }, { status: 400 })
        : Response.json({ count: 14, value: 14 });
    const { loadSavedCounts } = await import("./saved-counts");
    const { counts } = await loadSavedCounts([board, plain], fetchRun);
    expect(counts).toEqual({ p1: 14 });
    expect("b1" in counts).toBe(false);
  });

  test("shows no count: the sliders say it is a board, and its ⋯ says why it cannot be watched (#168, 16j)", () => {
    const html = sidebar({ p1: 14 });
    const boardRow = html.slice(html.indexOf("fleet · box"), html.indexOf("box commands"));
    expect(boardRow).not.toMatch(/>0<\/span>/);
    expect(boardRow).not.toMatch(/>—<\/span>/);
    expect(html).toMatch(/aria-label="A board"/);
    expect(html).toMatch(/title="Boards cannot be watched[^"]*"[^>]*aria-label="More for fleet · box"/);
    expect(html).toMatch(/>14<\/span>/);
  });
});
