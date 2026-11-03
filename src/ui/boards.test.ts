import { describe, expect, test } from "bun:test";
import {
  BOARD_MAX,
  BOARD_PANEL_MAX,
  addBoardPanel,
  bindForBoard,
  boardWatchRefuse,
  duplicateBoardPanel,
  formatBoard,
  panelQuery,
  panelWhat,
  parseBoard,
  removeBoardPanel,
  type BoardSlots,
} from "./boards";
import { defaultLayout, defaultTimeseries, type WidgetDef } from "../shared/widgets";

function stat(partial: Partial<WidgetDef> = {}): WidgetDef {
  return { ...defaultTimeseries({ id: "b", x: 8, w: 4, agg: "p99:duration_ms", ...partial }), kind: "stat" };
}

describe("parseBoard (#410)", () => {
  test("reads inputs and panels, drops junk, caps inputs at 4 and panels at 26", () => {
    const panels = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, q: `service:s${i}`, view: "events" }));
    const board = parseBoard({ keys: ["level", "service", "host", "status", "path"], panels: [...panels, { view: "nope" }] })!;
    expect(board.keys).toEqual(["level", "service", "host", "status"]);
    expect(board.panels).toHaveLength(BOARD_PANEL_MAX);
    expect(board.panels.map((p) => p.id).join("")).toBe("uvwxyzabcdefghijklmnopqrst");
    expect(BOARD_PANEL_MAX).toBe(26);
    expect(BOARD_MAX).toBe(4);
  });

  test("a panel keeps its query, view, cell and fixed window through a save", () => {
    const board = parseBoard({
      keys: ["region"],
      panels: [{ id: "u", name: "Checkout latency", q: "service:checkout", view: "stat", widget: stat(), fixed: "24h" }],
    })!;
    const again = parseBoard(formatBoard(board))!;
    expect(again).toEqual(board);
    expect(again.panels[0]).toMatchObject({ name: "Checkout latency", q: "service:checkout", view: "stat", fixed: "24h" });
    expect(again.panels[0]!.widget).toMatchObject({ kind: "stat", x: 8, w: 4, agg: "p99:duration_ms" });
  });

  test("a fixed window is relative or none", () => {
    const board = parseBoard({ panels: [{ view: "events", fixed: "2026-01-01" }] })!;
    expect(board.panels[0]!.fixed).toBeNull();
  });

  test("a board saved before #410 becomes one panel per widget on its template query", () => {
    const layout = defaultLayout();
    layout.widgets.push(stat({ id: "b" }));
    const board = parseBoard({ keys: ["host"], win: true }, { query: "service:checkout", widgets: layout })!;
    expect(board.keys).toEqual(["host"]);
    expect(board.panels.map((p) => [p.view, p.name, p.q])).toEqual([
      ["histogram", "Volume", "service:checkout"],
      ["stat", "p99(duration_ms)", "service:checkout"],
      ["events", "Events", "service:checkout"],
    ]);
    const events = board.panels[2]!.widget;
    expect(events.y).toBe(4);
    expect(events.w).toBe(12);
  });
});

describe("inputs", () => {
  test("set inputs are ANDed onto a panel's query; an unset input is any", () => {
    expect(panelQuery("service:a", ["env", "region"], { env: "prod" })).toBe("service:a env:prod");
    expect(panelQuery("service:a", ["env", "region"], {})).toBe("service:a");
    expect(panelQuery("", ["env"], { env: "prod" })).toBe("env:prod");
  });

  test("a query with a top-level OR is put in parentheses first", () => {
    expect(panelQuery("level:error OR level:fatal", ["region"], { region: "eu" })).toBe("(level:error OR level:fatal) region:eu");
    expect(panelQuery("service:billing (level:error OR level:fatal)", ["region"], { region: "eu" })).toBe(
      "service:billing (level:error OR level:fatal) region:eu",
    );
  });

  test("bindForBoard keeps only that board's input keys", () => {
    expect(bindForBoard({ install_name: "acme-eu", q: "nope" }, ["install_name"])).toEqual({ install_name: "acme-eu" });
  });
});

describe("panels", () => {
  const empty: BoardSlots = { keys: [], panels: [] };

  test("Add to board places a copy in the first free cell, up to 26", () => {
    let board: BoardSlots | null = empty;
    board = addBoardPanel(board, { name: "", q: "service:b", view: "histogram", widget: defaultTimeseries({ agg: "avg:special" }) })!;
    board = addBoardPanel(board, { name: "", q: "service:a", view: "stat", widget: stat() })!;
    expect(board.panels.map((p) => [p.id, p.widget.x, p.widget.y])).toEqual([
      ["u", 0, 0],
      ["v", 0, 4],
    ]);
    expect(board.panels[0]!.name).toBe("avg(special)");
    for (let i = 0; i < 24; i++) {
      board = addBoardPanel(board!, { name: "x", q: "", view: "events", widget: defaultTimeseries() });
    }
    expect(board!.panels).toHaveLength(26);
    expect(new Set(board!.panels.map((p) => p.id)).size).toBe(26);
    expect(addBoardPanel(board!, { name: "x", q: "", view: "events", widget: defaultTimeseries() })).toBeNull();
  });

  test("Duplicate keeps the fixed window; Remove drops the panel", () => {
    const one = parseBoard({ panels: [{ name: "Latency", view: "stat", widget: stat(), fixed: "24h" }] })!;
    const two = duplicateBoardPanel(one, "u")!;
    expect(two.panels.map((p) => [p.name, p.fixed])).toEqual([
      ["Latency", "24h"],
      ["Latency", "24h"],
    ]);
    expect(removeBoardPanel(two, "u").panels.map((p) => p.id)).toEqual(["v"]);
  });

  test("what a panel reads, as its head says it (39b)", () => {
    expect(panelWhat("histogram", defaultTimeseries())).toBe("by level");
    expect(panelWhat("top", { ...defaultTimeseries(), kind: "hbar", attr: "special", n: 5 })).toBe("Top 5 · special");
    expect(panelWhat("events", defaultTimeseries())).toBe("newest first");
  });
});

test("a board cannot be watched", () => {
  expect(boardWatchRefuse()).toBe("A board cannot be watched. Watch a saved hunt.");
});
