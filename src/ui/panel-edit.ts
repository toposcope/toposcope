import { maxLineName, type MetricLine, type WidgetDef } from "../shared/widgets";

/**
 * The panel editor's changes (#169, frames 17c–17e, 17i), kept apart from its
 * popover so each one can be tested.
 */

/** A metric can join a panel when it is counted in the panel's unit, or either unit is not known yet (17c). */
export function canJoin(panelUnit: string | null | undefined, unit: string | null | undefined): boolean {
  return !panelUnit || !unit || panelUnit === unit;
}

/** Gives a line (its index when merged, its value when split) a name, or takes the name away when blank. */
export function withLineName(names: Record<string, string>, key: string, value: string): Record<string, string> {
  const next = { ...names };
  if (value.trim()) {
    next[key] = value.slice(0, maxLineName);
  } else {
    delete next[key];
  }
  return next;
}

/**
 * Removes merged line `index` (1 and up; 0 is the panel's own metric). The
 * names follow their lines: the ones after it move up by one.
 */
export function withoutLine(widget: WidgetDef, index: number): Pick<WidgetDef, "lines" | "names"> {
  const lines = (widget.lines ?? []).filter((_, i) => i !== index - 1);
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(widget.names ?? {})) {
    const n = Number(key);
    if (n < index) names[key] = value;
    else if (n > index) names[String(n - 1)] = value;
  }
  return { lines, names };
}

/** Adds a metric as a merged line; a panel merges or splits, never both. */
export function withLine(widget: WidgetDef, metric: string): Pick<WidgetDef, "lines" | "metricSplit" | "names"> {
  const line: MetricLine = { metric, labels: {} };
  // Names given to a split's values mean nothing once it merges.
  const names = widget.metricSplit ? {} : (widget.names ?? {});
  return { lines: [...(widget.lines ?? []), line], metricSplit: null, names };
}
