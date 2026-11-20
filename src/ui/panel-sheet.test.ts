import { describe, expect, test } from "bun:test";
import { parseBoard } from "../shared/boards";
import { boardMenuItems } from "./board-menu";
import type { PanelData } from "./board-panel-data";
import { panelHead } from "./components/board-view";
import { draftOf, draftProblem, fieldsOf, newDraft, showOf, windowLine } from "./panel-draft";
import { panelNoEvents, panelSubtitle, statWords } from "./panel-head";

const data = (total: number): PanelData => ({ histogram: [], agg: null, total, from: null, to: null, fetchedAt: 0 });

describe("the board menu (49g)", () => {
  test("offers Pin or Unpin as the board is, and Delete last", () => {
    expect(boardMenuItems(false).map((i) => i.label)).toEqual(["Rename", "Duplicate board", "Pin to Home", "Delete board…"]);
    expect(boardMenuItems(true).map((i) => i.label)).toEqual(["Rename", "Duplicate board", "Unpin from Home", "Delete board…"]);
  });
});

describe("the panel sheet (49e, 49f)", () => {
  test("new panels: Volume 6 columns by level, Number 4 as a count, Top values 4 by a field", () => {
    const volume = fieldsOf(newDraft(), null);
    expect([volume.view, volume.widget.kind, volume.widget.w, volume.widget.split, volume.widget.metric]).toEqual(["histogram", "timeseries", 6, "level", null]);
    const number = fieldsOf(newDraft({ show: "number" }), null);
    expect([number.view, number.widget.kind, number.widget.w, number.widget.agg]).toEqual(["stat", "stat", 4, "count"]);
    const top = fieldsOf({ ...newDraft({ show: "top" }), field: "status" }, null);
    expect([top.view, top.widget.kind, top.widget.w, top.widget.attr]).toEqual(["top", "hbar", 4, "status"]);
    const byService = fieldsOf({ ...newDraft({ show: "top" }), field: "service" }, null);
    expect([byService.widget.split, byService.widget.attr]).toEqual(["service", null]);
  });

  test("Metric is a series on a Volume-sized panel, and needs a name", () => {
    const draft = { ...newDraft({ show: "metric" }), metric: "agental.call.duration" };
    const metric = fieldsOf(draft, null);
    expect([metric.view, metric.widget.metric, metric.widget.w]).toEqual(["histogram", "agental.call.duration", 6]);
    expect(showOf(metric)).toBe("metric");
    expect(draftProblem({ ...draft, metric: " " })).toBe("Pick a metric");
    expect(draftProblem(draft)).toBeNull();
  });

  test("From a saved hunt starts with its query and name", () => {
    const draft = newDraft({ name: "incus warnings", q: "service:incus level:warn" });
    expect([draft.name, draft.q, draft.show]).toEqual(["incus warnings", "service:incus level:warn", "volume"]);
  });

  test("Edit panel keeps the cell and the rest of the widget while Show is unchanged", () => {
    const board = parseBoard({
      panels: [
        { id: "u", name: "Metrics", view: "section", widget: { x: 0, y: 0, w: 12, h: 1 } },
        { id: "v", name: "p99", q: "service:api", view: "stat", widget: { x: 3, y: 1, w: 3, h: 2, agg: "p99:duration_ms" }, fixed: "4h" },
      ],
    })!;
    const panel = board.panels[1]!;
    const draft = draftOf(panel, board.panels);
    expect([draft.show, draft.section, draft.fixed]).toEqual(["number", "u", "4h"]);
    const kept = fieldsOf({ ...draft, name: "API p99" }, panel);
    expect([kept.view, kept.widget.agg, kept.widget.x, kept.widget.w, kept.fixed]).toEqual(["stat", "p99:duration_ms", 3, 3, "4h"]);
    const changed = fieldsOf({ ...draft, show: "volume" }, panel);
    expect([changed.view, changed.widget.kind, changed.widget.agg, changed.widget.x, changed.widget.w]).toEqual(["histogram", "timeseries", null, 3, 4]); // a Volume is at least 4 wide
  });

  test("a query fault holds the panel back", () => {
    expect(draftProblem({ ...newDraft(), q: "service:(" })).not.toBeNull();
    expect(draftProblem({ ...newDraft(), q: "service:api" })).toBeNull();
  });

  test("the Window row names the board's window or the fixed one", () => {
    expect(windowLine(null, "24h")).toBe("the board's, Last 24h");
    expect(windowLine("4h", "24h")).toBe("fixed, Last 4h");
  });
});

describe("panel heads and bodies (49d)", () => {
  const board = parseBoard({
    panels: [
      { id: "u", name: "incus", q: "service:incus", view: "histogram", widget: { split: "level" } },
      { id: "v", name: "All logs", view: "histogram", widget: { split: "level" } },
      { id: "w", name: "incus rate", q: "service:incus", view: "stat", widget: { agg: "rate" } },
      { id: "x", name: "count", q: "service:incus", view: "stat", widget: {} },
    ],
  })!;
  const [incus, all, rate, count] = board.panels;

  test("the faint words are the query and the split, a count says nothing more", () => {
    expect(panelSubtitle(incus!, "")).toBe("service:incus · by level");
    expect(panelSubtitle(all!, "")).toBe("by level");
    expect(panelSubtitle(incus!, "host:box")).toBe("service:incus host:box · by level");
    expect(panelSubtitle(count!, "")).toBe("service:incus");
  });

  test("the head's count has no `matching`, and a Number panel's head has none", () => {
    expect(panelHead(incus!, data(64300), false)).toEqual({ n: null, label: "" });
    expect(panelHead(rate!, data(0), false)).toBeNull();
    expect(panelHead(count!, data(12), false)).toBeNull();
  });

  test("a Number panel says the window it read, or that it read no events", () => {
    expect(statWords(12, { range: "24h" })).toBe("in the last 24h");
    expect(statWords(0, { range: "24h" })).toBe("no events in the last 24h");
  });

  test("a panel with no events says so; a metric or a failed read does not", () => {
    expect(panelNoEvents(incus!, data(0))).toBe(true);
    expect(panelNoEvents(incus!, data(3))).toBe(false);
    expect(panelNoEvents(incus!, null)).toBe(false);
    expect(panelNoEvents(incus!, { ...data(0), error: "Search failed" })).toBe(false);
    expect(panelNoEvents({ ...incus!, widget: { ...incus!.widget, metric: "cpu" } }, data(0))).toBe(false);
    expect(panelNoEvents(count!, data(0))).toBe(false);
  });
});
