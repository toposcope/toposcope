import { isAttrIdent } from "./attrs";
import { isCoreField } from "../query/compile";
import { seriesLabel } from "../query/agg";
import { isRelativeRange } from "../query/relative";
import {
  clampWidget,
  defaultLayout,
  defaultTimeseries,
  firstGap,
  isPinnedHistogram,
  parseSavedWidget,
  widgetGridCols,
  type WidgetDef,
  type WidgetLayout,
} from "./widgets";

/** Inputs on a board (#410): field keys ANDed onto every panel's query. */
export const BOARD_MAX = 4;
/** Panels on a board (#410): one letter each, so at most 26. */
export const BOARD_PANEL_MAX = 26;
export const maxPanelName = 80;

/**
 * What a board panel draws (#410): a hunt panel's view, or the hunt's event table; or, read from
 * nothing (sheet 44), a section heading or a note.
 */
export const boardPanelViews = ["histogram", "stat", "top", "events", "section", "note"] as const;
export type BoardPanelView = (typeof boardPanelViews)[number];
/** A note panel's text (sheet 44). */
export const maxNoteText = 1000;

/** A section heading or a note: it reads no rows and has no query or window. */
export function isTextPanel(view: BoardPanelView): view is "section" | "note" {
  return view === "section" || view === "note";
}

/**
 * A board panel (#410, sheet 39): a copy of a hunt panel. It keeps its own query, its view
 * (`widget` holds the series, split, Top-N key and its grid cell) and, when it has one, a fixed
 * window that it reads in place of the board's.
 */
export type BoardPanel = {
  id: string;
  name: string;
  q: string;
  view: BoardPanelView;
  widget: WidgetDef;
  /** A relative range (`24h`); null follows the board's window. */
  fixed: string | null;
  /** A note panel's text (sheet 44). */
  text?: string;
  /** A section heading whose panels are folded away (sheet 44). */
  folded?: boolean;
};

export type BoardSlots = {
  keys: string[];
  panels: BoardPanel[];
};

/** What a board panel was, before #410: its saved search's query and layout. */
export type LegacyBoardSource = {
  query: string;
  widgets: WidgetLayout | null;
  agg?: string | null;
};

/** `u`–`z` first, as boards before 0.14.2 numbered them, then `a`–`t`. */
const panelIds = "uvwxyzabcdefghijklmnopqrst";
const eventsH = 5;

export function parseBoard(raw: unknown, legacy?: LegacyBoardSource): BoardSlots | null {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const keys: string[] = [];
  if (Array.isArray(rec.keys)) {
    for (const item of rec.keys) {
      if (typeof item !== "string") {
        continue;
      }
      const key = item.trim().toLowerCase();
      if (!isBoardFieldKey(key) || keys.includes(key) || keys.length >= BOARD_MAX) {
        continue;
      }
      keys.push(key);
    }
  }
  if (!Array.isArray(rec.panels)) {
    // A board saved before #410 has a template query and a layout: each widget becomes a panel.
    return { keys, panels: legacy ? legacyPanels(legacy) : [] };
  }
  const panels: BoardPanel[] = [];
  for (const item of rec.panels) {
    if (panels.length >= BOARD_PANEL_MAX) {
      break;
    }
    const panel = parseBoardPanel(item, panels);
    if (panel) {
      panels.push(panel);
    }
  }
  return { keys, panels };
}

function parseBoardPanel(raw: unknown, taken: BoardPanel[]): BoardPanel | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const view = (boardPanelViews as readonly string[]).includes(rec.view as string)
    ? (rec.view as BoardPanelView)
    : null;
  if (!view) {
    return null;
  }
  const idRaw = typeof rec.id === "string" ? rec.id.trim().toLowerCase() : "";
  const id =
    panelIds.includes(idRaw) && idRaw.length === 1 && !taken.some((p) => p.id === idRaw)
      ? idRaw
      : nextPanelId(taken);
  if (!id) {
    return null;
  }
  const widget = panelWidget(view, rec.widget, id);
  const name = normalizeName(rec.name) ?? defaultPanelName(view, widget);
  const q = typeof rec.q === "string" ? rec.q.trim() : "";
  if (isTextPanel(view)) {
    const text = view === "note" && typeof rec.text === "string" ? rec.text.trim().slice(0, maxNoteText) : "";
    return {
      id,
      name,
      q: "",
      view,
      widget,
      fixed: null,
      ...(view === "note" ? { text } : {}),
      ...(view === "section" && rec.folded === true ? { folded: true } : {}),
    };
  }
  const fixed = typeof rec.fixed === "string" && isRelativeRange(rec.fixed.trim()) ? rec.fixed.trim() : null;
  return { id, name, q, view, widget, fixed };
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxPanelName).trimEnd() : null;
}

/** The widget behind a view: its kind follows the view; the event table keeps only a cell. */
function panelWidget(view: BoardPanelView, raw: unknown, id: string): WidgetDef {
  // A note sizes as a stat does; a heading is one full-width row.
  const kind = view === "stat" || view === "note" ? "stat" : view === "top" ? "hbar" : "timeseries";
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const parsed = parseSavedWidget({ w: widgetGridCols, h: view === "events" ? eventsH : 4, ...rec, id: "b", kind });
  const base = parsed ?? clampWidget({ ...defaultTimeseries({ id: "b" }), kind });
  if (view === "events") {
    return { ...clampWidget({ ...defaultTimeseries({ id: "b" }), x: base.x, y: base.y, w: base.w, h: base.h }), id };
  }
  if (view === "section") {
    return { ...clampWidget({ ...defaultTimeseries({ id: "b" }), kind: "stat", y: base.y }), x: 0, w: widgetGridCols, h: 1, id };
  }
  if (view === "note") {
    return { ...clampWidget({ ...defaultTimeseries({ id: "b" }), kind: "stat", x: base.x, y: base.y, w: base.w, h: base.h }), id };
  }
  return { ...base, id };
}

export function nextPanelId(panels: Array<{ id: string }>): string | null {
  for (const id of panelIds) {
    if (!panels.some((panel) => panel.id === id)) {
      return id;
    }
  }
  return null;
}

/** The name a panel gets when it has none: what it reads. */
export function defaultPanelName(view: BoardPanelView, widget: WidgetDef): string {
  if (view === "events") {
    return "Events";
  }
  if (view === "section") {
    return "Section";
  }
  if (view === "note") {
    return "Note";
  }
  if (widget.title) {
    return widget.title;
  }
  if (view === "histogram" && !widget.agg && !widget.metric) {
    return "Volume";
  }
  return panelWhat(view, widget);
}

/** The muted words after a panel's name (39b): `by level`, `p99(duration_ms)`, `Top 5 · status`, `newest first`. */
export function panelWhat(view: BoardPanelView, widget: WidgetDef): string {
  switch (view) {
    case "events":
      return "newest first";
    case "section":
    case "note":
      return "";
    case "top":
      return `Top ${widget.n} · ${widget.attr ?? widget.split}`;
    case "stat":
      return widget.metric ?? (widget.agg && widget.agg !== "count" ? seriesLabel(widget.agg) : "count");
    case "histogram":
      if (widget.metric) {
        return widget.metric;
      }
      if (widget.agg) {
        return seriesLabel(widget.agg);
      }
      return widget.split === "none" ? "count" : `by ${widget.split}`;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export function panelViewOf(widget: WidgetDef): BoardPanelView {
  return widget.kind === "stat" ? "stat" : widget.kind === "hbar" ? "top" : "histogram";
}

/** #410 migration: one panel per widget the board had, each on its template query. */
function legacyPanels(source: LegacyBoardSource): BoardPanel[] {
  const layout = source.widgets ?? defaultLayout({ agg: source.agg ?? null });
  const q = source.query.trim();
  const panels: BoardPanel[] = [];
  const ordered = [...layout.widgets].sort((a, b) => Number(!isPinnedHistogram(a)) - Number(!isPinnedHistogram(b)));
  for (const widget of ordered) {
    const id = nextPanelId(panels);
    if (!id || panels.length >= BOARD_PANEL_MAX) {
      break;
    }
    const view = panelViewOf(widget);
    const own = { ...clampWidget({ ...widget, id: "b" }), id };
    panels.push({ id, name: defaultPanelName(view, own), q, view, widget: own, fixed: null });
  }
  if (layout.logs && panels.length < BOARD_PANEL_MAX) {
    const id = nextPanelId(panels)!;
    const bottom = panels.reduce((max, p) => Math.max(max, p.widget.y + p.widget.h), 0);
    const widget = { ...clampWidget({ ...defaultTimeseries({ id: "b" }), x: 0, y: bottom, w: widgetGridCols, h: eventsH }), id };
    panels.push({ id, name: "Events", q, view: "events", widget, fixed: null });
  }
  return panels;
}

export function formatBoard(board: BoardSlots | null): string | null {
  if (!board) {
    return null;
  }
  return JSON.stringify({
    keys: board.keys,
    panels: board.panels.slice(0, BOARD_PANEL_MAX).map(formatPanel),
  });
}

function formatPanel(panel: BoardPanel): Record<string, unknown> {
  const { id: _id, ...widget } = panel.widget;
  return {
    id: panel.id,
    name: panel.name,
    q: panel.q,
    view: panel.view,
    widget: panel.view === "events" || isTextPanel(panel.view) ? { x: widget.x, y: widget.y, w: widget.w, h: widget.h } : widget,
    fixed: panel.fixed,
    ...(panel.view === "note" ? { text: panel.text ?? "" } : {}),
    ...(panel.view === "section" && panel.folded ? { folded: true } : {}),
  };
}

export function isBoardFieldKey(key: string): boolean {
  return isCoreField(key) || isAttrIdent(key);
}

/** The set inputs, in the board's order; an unset input is `any` and adds nothing (#410). */
export function setInputs(keys: string[], bind: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of keys) {
    const value = (bind[key] ?? "").trim();
    if (value) {
      out.push([key, value]);
    }
  }
  return out;
}

export function bindForBoard(
  candidates: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = candidates[key];
    if (value && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/** A new panel from a hunt panel (#410, 39e): its query and view, placed in the first free cell. */
export function addBoardPanel(
  board: BoardSlots,
  input: { name: string; q: string; view: BoardPanelView; widget: WidgetDef },
): BoardSlots | null {
  if (board.panels.length >= BOARD_PANEL_MAX) {
    return null;
  }
  const id = nextPanelId(board.panels);
  if (!id) {
    return null;
  }
  const draft = input.view === "events"
    ? clampWidget({ ...defaultTimeseries({ id: "b" }), w: widgetGridCols, h: eventsH })
    : clampWidget({ ...input.widget, id: "b" });
  const others = board.panels.map((panel) => ({ ...panel.widget, id: "z" + panel.id }));
  const placed = { ...firstGap(others as WidgetDef[], { ...draft, x: 0, y: 0 }), id };
  const name = normalizeName(input.name) ?? defaultPanelName(input.view, placed);
  return {
    ...board,
    panels: [...board.panels, { id, name, q: input.q.trim(), view: input.view, widget: placed, fixed: null }],
  };
}

/** A section heading or a note at the bottom of the board (sheet 44); null at the cap. */
export function addTextPanel(board: BoardSlots, view: "section" | "note"): BoardSlots | null {
  const id = nextPanelId(board.panels);
  if (!id || board.panels.length >= BOARD_PANEL_MAX) {
    return null;
  }
  const bottom = board.panels.reduce((max, p) => Math.max(max, p.widget.y + p.widget.h), 0);
  const cell = view === "section" ? { x: 0, y: bottom, w: widgetGridCols, h: 1 } : { x: 0, y: bottom, w: 4, h: 2 };
  const widget = { ...clampWidget({ ...defaultTimeseries({ id: "b" }), kind: "stat" }), ...cell, id };
  const panel: BoardPanel =
    view === "section"
      ? { id, name: "New section", q: "", view, widget, fixed: null }
      : { id, name: "Note", q: "", view, widget, fixed: null, text: "" };
  return { ...board, panels: [...board.panels, panel] };
}

/**
 * The panels under each folded heading (sheet 44): from the row under it to the next heading.
 * They are left out of the drawn layout and keep their own cells, so unfolding puts them back.
 */
export function foldedPanelIds(panels: BoardPanel[]): Set<string> {
  const out = new Set<string>();
  const headings = panels.filter((p) => p.view === "section").sort((a, b) => a.widget.y - b.widget.y);
  headings.forEach((heading, i) => {
    if (!heading.folded) {
      return;
    }
    const next = headings[i + 1]?.widget.y ?? Infinity;
    for (const p of sectionMembers(panels, heading.id, next)) {
      out.add(p.id);
    }
  });
  return out;
}

/** The panels under a heading, down to the next heading (or the given row). */
export function sectionMembers(panels: BoardPanel[], id: string, until?: number): BoardPanel[] {
  const heading = panels.find((p) => p.id === id);
  if (!heading) {
    return [];
  }
  const next =
    until ?? Math.min(Infinity, ...panels.filter((p) => p.view === "section" && p.widget.y > heading.widget.y).map((p) => p.widget.y));
  return panels.filter((p) => p.view !== "section" && p.widget.y > heading.widget.y && p.widget.y < next);
}

/** Duplicate: a second copy of the panel under it, in the first free cell. */
export function duplicateBoardPanel(board: BoardSlots, id: string): BoardSlots | null {
  const panel = board.panels.find((item) => item.id === id);
  if (!panel) {
    return null;
  }
  const next = addBoardPanel(board, panel);
  if (!next) {
    return null;
  }
  const copy = next.panels[next.panels.length - 1]!;
  next.panels[next.panels.length - 1] = { ...copy, fixed: panel.fixed, ...(panel.view === "note" ? { text: panel.text ?? "" } : {}) };
  return next;
}

export function patchBoardPanel(board: BoardSlots, id: string, patch: Partial<Omit<BoardPanel, "id">>): BoardSlots {
  return {
    ...board,
    panels: board.panels.map((panel) => (panel.id === id ? { ...panel, ...patch } : panel)),
  };
}

export function removeBoardPanel(board: BoardSlots, id: string): BoardSlots {
  return { ...board, panels: board.panels.filter((panel) => panel.id !== id) };
}

export function boardWatchRefuse(): string {
  return "A board cannot be watched. Watch a saved hunt.";
}
