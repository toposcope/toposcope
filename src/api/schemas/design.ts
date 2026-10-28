import * as v from "valibot";
import { fieldRoles } from "../../shared/fields";

/** The design routes' bodies (#360): a panel, a field's role, a note. */
function described<T extends v.GenericSchema>(schema: T, description: string) {
  return v.pipe(schema, v.description(description));
}

const labels = v.record(v.string(), v.string());

/** A panel, as a saved search's canvas keeps it; on a change, a field left out stays as it is. */
export const panelBody = v.object({
  kind: v.optional(described(v.picklist(["timeseries", "stat", "hbar"], "kind must be timeseries, stat or hbar"), "timeseries (bars or lines over time), stat (one number) or hbar (top values); required to add one.")),
  x: v.optional(described(v.number(), "Its column, 0 to 11; left out, it goes in the first gap.")),
  y: v.optional(described(v.number(), "Its row from the top; left out, it goes in the first gap. Panels it lands on move down.")),
  w: v.optional(described(v.number(), "How many of the 12 columns it spans.")),
  h: v.optional(described(v.number(), "How many rows tall it is, 2 to 8.")),
  split: v.optional(described(v.string(), "timeseries, hbar: what its bars are split by: level, service, host or none.")),
  chart: v.optional(described(v.string(), "timeseries: stacked, bars or lines.")),
  agg: v.nullish(described(v.string(), "timeseries, stat: the series it reads, as search's agg takes it (p99(duration_ms)); null counts rows.")),
  replaceY: v.optional(described(v.boolean(), "timeseries: a metric draws in place of the row counts.")),
  logScale: v.optional(described(v.boolean(), "timeseries: a log scale.")),
  attr: v.nullish(described(v.string(), "hbar: the attribute key whose values it ranks, in place of split.")),
  pct: v.optional(described(v.boolean(), "hbar: each value as a share of the total.")),
  n: v.optional(described(v.number(), "hbar: how many values, 1 to 50.")),
  metric: v.nullish(described(v.string(), "timeseries, stat: an ingested metric it draws, in place of rows.")),
  metricLabels: v.optional(described(labels, "The labels that pick the metric's series.")),
  metricSplit: v.nullish(described(v.string(), "timeseries: a metric label, one line per value.")),
  metricChart: v.optional(described(v.string(), "timeseries with a metric: line, bars or stacked.")),
  topView: v.optional(described(v.string(), "hbar: donut, to draw it as a donut.")),
  lines: v.optional(described(v.array(v.object({ metric: v.string(), labels: v.optional(labels) })), "timeseries with a metric: up to three more metrics of its unit on its axis.")),
  names: v.optional(described(labels, "A name for each line: 0 to 3 for merged lines, a label value for a split's.")),
  title: v.optional(described(v.string(), "timeseries: a title of its own, up to 80 characters.")),
  note: v.optional(described(v.string(), "timeseries: what it is for, up to 160 characters.")),
});

export const fieldRoleBody = v.object({
  role: described(v.picklist(fieldRoles, `role must be ${fieldRoles.join(", ")}`), "chart (the default: a facet with its values counted), lookup (an id you follow, never charted) or ignore (not charted); a role applies to rows that arrive after it."),
});

export const noteBody = v.object({
  title: described(v.string("title is required"), "What happened, in one line, up to 500 characters."),
  ts: v.optional(described(v.string(), "When, an ISO time; now when left out.")),
  service: v.optional(described(v.string(), "The service it is about, if one.")),
  attrs: v.optional(described(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])), "More about it, as key: value.")),
});
