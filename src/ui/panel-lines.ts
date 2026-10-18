import type { SearchAggResult } from "../query/agg";
import { formatMetricLabels } from "../shared/metric";
import { widgetLineQueries, type SeriesQuery, type WidgetDef } from "../shared/widgets";
import { printUnit } from "./metric-unit";

/**
 * What a panel draws once its lines are put together (#169, frames 17b–17i):
 * merged metrics as one line each on one axis, a split's values, each under
 * the name it was given. Drawn the way a split already is.
 */
export type PanelLines = {
  agg: SearchAggResult | null;
  /** A merged line whose metric is now sent in another unit: left off, and said (17e). */
  leftOff: Array<{ name: string; metric: string; unit: string }>;
  /** What the sender wrote about the panel's own metric (#167), for a one-line panel with no note (17f). */
  description: string | null;
  /** Each drawn line: its name, what it is, and what its sender said, for its hover (17f). */
  legend: Array<{ key: string; metric: string; labels: string; description: string | null }>;
};

/** A line's name when it was given none: its metric, and its labels when it has them. */
function plainName(query: SeriesQuery): string {
  const labels = formatMetricLabels(query.metricLabels);
  return labels ? `${query.metric} {${labels}}` : (query.metric ?? "");
}

/** Two lines never share a key, so two that were given one name still both draw. */
function unique(key: string, taken: Set<string>): string {
  let next = key;
  for (let n = 2; taken.has(next); n++) {
    next = `${key} (${n})`;
  }
  taken.add(next);
  return next;
}

export function panelLines(
  widget: WidgetDef,
  resultFor: (query: SeriesQuery) => SearchAggResult | null | undefined,
): PanelLines {
  const queries = widgetLineQueries(widget);
  const own = resultFor(queries[0]!) ?? null;
  const description = own?.description ?? null;
  const names = widget.names ?? {};
  if (!own || own.source === "refused") {
    return { agg: own, leftOff: [], description, legend: [] };
  }
  if (queries.length > 1) {
    const unit = own.unit ?? null;
    const taken = new Set<string>();
    const splits: NonNullable<SearchAggResult["splits"]> = [];
    const leftOff: PanelLines["leftOff"] = [];
    const legend: PanelLines["legend"] = [];
    queries.forEach((query, index) => {
      const result = index === 0 ? own : resultFor(query);
      const name = names[String(index)] ?? plainName(query);
      if (!result || result.source === "refused") {
        return;
      }
      // One unit on one axis (17e): a line sent in another unit since it was merged is left off.
      if (unit && result.unit && result.unit !== unit) {
        leftOff.push({ name, metric: query.metric ?? "", unit: printUnit(result.unit) || result.unit });
        return;
      }
      const key = unique(name, taken);
      splits.push({ key, buckets: result.buckets, stat: result.stat });
      legend.push({
        key,
        metric: query.metric ?? "",
        labels: formatMetricLabels(query.metricLabels),
        description: result.description ?? null,
      });
    });
    return { agg: { ...own, splits }, leftOff, description, legend };
  }
  if (own.splits && Object.keys(names).length > 0) {
    // A split whose values were given names (17i): the value stays one hover away.
    const taken = new Set<string>();
    const legend: PanelLines["legend"] = [];
    const splits = own.splits.map((line) => {
      const key = unique(names[line.key] ?? line.key, taken);
      legend.push({ key, metric: own.metric ?? widget.metric ?? "", labels: `${own.split ?? ""}:${line.key}`, description });
      return { ...line, key };
    });
    return { agg: { ...own, splits }, leftOff: [], description, legend };
  }
  return { agg: own, leftOff: [], description, legend: [] };
}

/** What a panel's note line says (17d, 17f): the operator's note, else the sender's description on a one-line panel. */
export function panelNote(widget: WidgetDef, lines: PanelLines): { text: string; sender: boolean } | null {
  if (widget.note) {
    return { text: widget.note, sender: false };
  }
  const oneLine = !widget.lines?.length && !widget.metricSplit;
  return oneLine && lines.description ? { text: lines.description, sender: true } : null;
}
