import type { HistogramSplit } from "../query/histogram";
import { compileQuery } from "../query/compile";
import { formatSearchAgg, numericAggOps, parseSearchAgg, type NumericAggOp } from "../query/agg";
import { clampWidget, defaultHbarN, defaultTimeseries, defaultWidgetH, type WidgetDef } from "../shared/widgets";
import { panelSection, type BoardPanel, type PanelFields } from "../shared/boards";
import { panelDisplayName } from "../shared/panel-name";

/**
 * The panel sheet (sheet 49, 49e–49f): one form for Add panel and Edit panel. Show picks the view;
 * the rest of the panel's widget is kept when Show stays what it was.
 */
export type PanelShow = "volume" | "top" | "number" | "metric";

export const panelShows: Array<{ show: PanelShow; label: string; sub: string }> = [
  { show: "volume", label: "Volume", sub: "Events over time, split by a field" },
  { show: "top", label: "Top values", sub: "The most common values of a field" },
  { show: "number", label: "Number", sub: "One count or rate for the window" },
  { show: "metric", label: "Metric", sub: "A series an agent or exporter sends" },
];

/** A new panel's width in columns (49f): Volume and Metric half the board, Number and Top values a third. */
export const showWidth: Record<PanelShow, number> = { volume: 6, top: 4, number: 4, metric: 6 };
const showHeight: Record<PanelShow, number> = { volume: defaultWidgetH, top: defaultWidgetH, number: 2, metric: defaultWidgetH };

/** Split by for Volume (49f). */
export const volumeSplits: Array<{ split: HistogramSplit; label: string }> = [
  { split: "level", label: "Level" },
  { split: "service", label: "Service" },
  { split: "host", label: "Host" },
  { split: "none", label: "None" },
];

/** What a Number panel reads (sheet 49f): a count, a rate, or a reducer over a numeric field. */
export type NumberMeasure = "count" | "rate" | NumericAggOp;

export const numberMeasures: Array<{ measure: NumberMeasure; label: string }> = [
  { measure: "count", label: "Count" },
  { measure: "rate", label: "Rate per second" },
  { measure: "sum", label: "Sum of" },
  { measure: "avg", label: "Average of" },
  { measure: "p99", label: "p99 of" },
  { measure: "max", label: "Max of" },
  { measure: "min", label: "Min of" },
];

/** True when the measure reads a field (`sum:duration_ms`), not the rows themselves. */
export function measureNeedsField(measure: NumberMeasure): boolean {
  return (numericAggOps as readonly string[]).includes(measure);
}

/** A Number panel's stored agg as a measure and its field; anything unreadable is a count. */
export function measureOf(agg: string | null | undefined): { measure: NumberMeasure; measureField: string } {
  try {
    const parsed = agg && agg !== "count" ? parseSearchAgg(agg) : null;
    if (parsed?.op === "rate") {
      return { measure: "rate", measureField: "" };
    }
    if (parsed) {
      return { measure: parsed.op, measureField: parsed.key };
    }
  } catch {
    // A stored agg the grammar no longer reads stays a count.
  }
  return { measure: "count", measureField: "" };
}

/** The agg a Number draft stores: `count`, `rate`, or `<op>:<field>`. */
export function measureAgg(draft: Pick<PanelDraft, "measure" | "measureField">): string {
  if (draft.measure === "count" || draft.measure === "rate") {
    return draft.measure;
  }
  return formatSearchAgg({ op: draft.measure, key: draft.measureField.trim().toLowerCase() });
}

export type PanelDraft = {
  name: string;
  q: string;
  /** Null for an event table, which the sheet keeps as it is. */
  show: PanelShow | null;
  /** Volume's split. */
  split: HistogramSplit;
  /** Top values: the field it ranks (`service`, `status`). */
  field: string;
  /** Metric: the series' name. */
  metric: string;
  /** Number: what it reads, and the numeric field a reducer reads. */
  measure: NumberMeasure;
  measureField: string;
  /** The heading it sits under; null above the first heading. */
  section: string | null;
  fixed: string | null;
};

/** What Show a board panel is. */
export function showOf(panel: Pick<BoardPanel, "view" | "widget">): PanelShow | null {
  switch (panel.view) {
    case "histogram":
      return panel.widget.metric ? "metric" : "volume";
    case "top":
      return "top";
    case "stat":
      return "number";
    default:
      return null;
  }
}

/** A blank draft for Add panel, or one from a saved hunt's query and name. */
export function newDraft(seed?: { name?: string; q?: string; show?: PanelShow; section?: string | null }): PanelDraft {
  return {
    name: seed?.name ?? "",
    q: seed?.q ?? "",
    show: seed?.show ?? "volume",
    split: "level",
    field: "service",
    metric: "",
    measure: "count",
    measureField: "",
    section: seed?.section ?? null,
    fixed: null,
  };
}

/** The draft Edit panel starts from; a generic name starts as the one made from its query (50e). */
export function draftOf(panel: BoardPanel, panels: BoardPanel[]): PanelDraft {
  const w = panel.widget;
  return {
    name: panelDisplayName(panel),
    q: panel.q,
    show: showOf(panel),
    split: w.split,
    field: w.attr ?? (w.split === "none" ? "service" : w.split),
    metric: w.metric ?? "",
    ...(panel.view === "stat" ? measureOf(w.agg) : { measure: "count" as const, measureField: "" }),
    section: panelSection(panels, panel.id),
    fixed: panel.fixed,
  };
}

const coreSplits = new Set<string>(["level", "service", "host"]);

/**
 * The panel a draft makes: its view and widget. `base` is the panel being edited; its cell, its
 * words and, while Show is unchanged, the rest of its widget are kept.
 */
export function fieldsOf(draft: PanelDraft, base: BoardPanel | null): PanelFields {
  const name = draft.name;
  const q = draft.q;
  const fixed = draft.fixed;
  if (draft.show === null) {
    return { name, q, fixed, view: base?.view ?? "events", widget: base?.widget ?? defaultTimeseries({ id: "b" }) };
  }
  const same = base !== null && showOf(base) === draft.show;
  const cell = base
    ? { x: base.widget.x, y: base.widget.y, w: base.widget.w, h: base.widget.h }
    : { x: 0, y: 0, w: showWidth[draft.show], h: showHeight[draft.show] };
  const words: Partial<WidgetDef> = base ? { title: base.widget.title, note: base.widget.note } : {};
  const from = same ? base.widget : defaultTimeseries({ id: "b" });
  switch (draft.show) {
    case "volume": {
      const widget = clampWidget({ ...from, ...words, ...cell, kind: "timeseries", split: draft.split, metric: null, metricLabels: {} });
      return { name, q, fixed, view: "histogram", widget };
    }
    case "metric": {
      const metric = draft.metric.trim();
      const keep = same && base.widget.metric === metric;
      const widget = clampWidget({
        ...from,
        ...words,
        ...cell,
        kind: "timeseries",
        agg: null,
        metric: metric || null,
        metricLabels: keep ? base.widget.metricLabels : {},
        ...(keep ? {} : { metricSplit: null, lines: undefined, names: undefined }),
      });
      return { name, q, fixed, view: "histogram", widget };
    }
    case "top": {
      const field = draft.field.trim() || "service";
      const core = coreSplits.has(field);
      const widget = clampWidget({
        ...from,
        ...words,
        ...cell,
        kind: "hbar",
        split: core ? (field as HistogramSplit) : "none",
        attr: core ? null : field,
        n: same ? base.widget.n : defaultHbarN,
        agg: null,
        metric: null,
        metricLabels: {},
      });
      return { name, q, fixed, view: "top", widget };
    }
    case "number": {
      const agg = measureAgg(draft);
      const widget = clampWidget(
        same
          ? { ...from, ...words, ...cell, kind: "stat", agg }
          : { ...from, ...words, ...cell, kind: "stat", agg, metric: null, metricLabels: {} },
      );
      return { name, q, fixed, view: "stat", widget };
    }
    default: {
      const _exhaustive: never = draft.show;
      return _exhaustive;
    }
  }
}

/** Why the draft cannot be added yet, in the field's words; null when it can. */
export function draftProblem(draft: PanelDraft): string | null {
  const fault = compileQuery(draft.q).faults[0];
  if (fault) {
    return fault.msg;
  }
  if (draft.show === "metric" && !draft.metric.trim()) {
    return "Pick a metric";
  }
  if (draft.show === "top" && !draft.field.trim()) {
    return "Pick a field";
  }
  if (draft.show === "number" && measureNeedsField(draft.measure)) {
    const key = draft.measureField.trim();
    if (!key) {
      return "Pick a field to measure";
    }
    try {
      parseSearchAgg(measureAgg(draft));
    } catch {
      return `${key} cannot be measured`;
    }
  }
  return null;
}

/** What the Window row says (49f): `the board's, Last 24h`, or `fixed, Last 4h`. */
export function windowLine(fixed: string | null, boardWin: string): string {
  return fixed ? `fixed, Last ${fixed}` : `the board's, Last ${boardWin}`;
}

