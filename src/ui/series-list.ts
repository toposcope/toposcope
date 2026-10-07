import { pickerNumericKeys, type SeriesPick } from "./agg-picker";

/** How an ingested metric's bars are read. */
export type MetricKindName = "gauge" | "counter";

export type MetricEntry = { name: string; kind: MetricKindName; points: number };

/** The busiest metrics shown before anything is typed. */
export const untypedMetrics = 8;

/**
 * A dotted name cut in the middle, at dots: the first and last segments, then
 * segments added back from the front and the end in turn while they fit. The
 * end is what tells two names apart, so it is what survives.
 */
export function midCut(name: string, max: number): string {
  if (name.length <= max) {
    return name;
  }
  const parts = name.split(".");
  if (parts.length < 2) {
    return `${name.slice(0, Math.max(1, max - 1))}…`;
  }
  let head = 1;
  let tail = 1;
  const cut = () => `${parts.slice(0, head).join(".")}…${parts.slice(parts.length - tail).join(".")}`;
  if (cut().length > max) {
    return `…${name.slice(-(max - 1))}`;
  }
  let turn = 0;
  let stuck = 0;
  while (head + tail < parts.length && stuck < 2) {
    const before = [head, tail] as const;
    if (turn % 2 === 0) {
      head += 1;
    } else {
      tail += 1;
    }
    if (cut().length > max) {
      [head, tail] = before;
      stuck += 1;
    } else {
      stuck = 0;
    }
    turn += 1;
  }
  return cut();
}

/** The name around the first place `q` is found, in any case: before, the hit, after. */
export function splitHit(name: string, q: string): [string, string, string] {
  const at = q.length > 0 ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return at < 0 ? [name, "", ""] : [name.slice(0, at), name.slice(at, at + q.length), name.slice(at + q.length)];
}

/**
 * A gauge's one reading and a counter's, as printed beside the name. The bar
 * width rides with a counter's sum because it is part of the number.
 */
export function metricReading(kind: MetricKindName, step: string, compact = false): string {
  if (kind === "gauge") {
    return "avg";
  }
  return step.length === 0 ? "sum" : compact ? `sum/${step}` : `sum / ${step}`;
}

/** What that reading means for one bar, in words. */
export function readingWords(kind: MetricKindName, step: string): string {
  const bar = step.length > 0 ? `this ${step}` : "this bar";
  return kind === "gauge"
    ? `gauge · average level in ${bar}`
    : `counter · arrived in ${bar} — not a level`;
}

/** A Stat card's note: one number for the whole window. */
export function statWords(kind: MetricKindName, window: string): string {
  const over = window.length > 0 ? `over the last ${window}` : "over this window";
  return kind === "gauge" ? `avg level ${over} · gauge` : `sum ${over} · counter`;
}

export type SeriesRow = {
  /** What `applySeriesSelect` takes: "", "rate", "k:<field>", "m:<metric>". */
  value: string;
  name: string;
  /** Off, Count and Rate are plain words; a field or a metric is a name. */
  plain: boolean;
  /** The word in the right column. */
  tag: string;
  amber: boolean;
  on: boolean;
};

export type SeriesSection = {
  id: "picked" | "base" | "fields" | "metrics";
  head: string;
  meta: string;
  rows: SeriesRow[];
};

export type SeriesList = {
  sections: SeriesSection[];
  /** Under the metrics, when nothing is typed and there are more than are shown. */
  more: string;
  emptyTitle: string;
  emptyBody: string;
  /** Fields and metrics found by what was typed. */
  matches: number;
};

/**
 * The typed list behind the Series control. Off (Count on a card), Rate and
 * the numeric log fields keep the top; metrics follow in their own section.
 * A picked metric is listed once, under Picked, points or no points.
 */
export function buildSeriesList(opts: {
  card: boolean;
  pick: SeriesPick;
  /** The picked metric as the window has it; missing or zero points is "no points". */
  picked?: MetricEntry | null;
  /** The log series as the URL has it, so a field outside the busiest eight stays listed. */
  agg: string | null;
  numericKeys: readonly string[];
  metrics: readonly MetricEntry[];
  metricTotal: number;
  filter: string;
  /** "1h" for a relative window; empty for a custom one. */
  window: string;
}): SeriesList {
  const q = opts.filter.trim().toLowerCase();
  const typed = q.length > 0;
  const has = (name: string) => !typed || name.toLowerCase().includes(q);
  const last = opts.window.length > 0 ? `the last ${opts.window}` : "this window";
  const metaWindow = opts.window.length > 0 ? ` · ${opts.window}` : "";
  const onValue =
    opts.pick.kind === "metric"
      ? `m:${opts.pick.name}`
      : opts.pick.kind === "key"
        ? `k:${opts.pick.key}`
        : opts.pick.kind === "rate"
          ? "rate"
          : "";
  const sections: SeriesSection[] = [];

  const pickedName = opts.pick.kind === "metric" ? opts.pick.name : null;
  if (pickedName) {
    const kind = opts.picked?.kind ?? "gauge";
    const quiet = !opts.picked || opts.picked.points === 0;
    sections.push({
      id: "picked",
      head: "Picked",
      meta: quiet ? "" : "stays here while picked",
      rows: [
        {
          value: `m:${pickedName}`,
          name: pickedName,
          plain: false,
          tag: quiet ? `no points · ${kind}` : kind,
          amber: quiet,
          on: true,
        },
      ],
    });
  }

  const base = [opts.card ? "Count" : "Off", "Rate"].filter(has);
  if (base.length > 0) {
    sections.push({
      id: "base",
      head: "",
      meta: "",
      rows: base.map((name) => {
        const value = name === "Rate" ? "rate" : "";
        return { value, name, plain: true, tag: "", amber: false, on: value === onValue };
      }),
    });
  }

  const allFields = [...new Set(opts.numericKeys.map((key) => key.trim().toLowerCase()))].filter(
    (key) => key.length > 0,
  );
  const fields = typed ? allFields.filter(has) : pickerNumericKeys([...opts.numericKeys], opts.agg);
  if (fields.length > 0) {
    sections.push({
      id: "fields",
      head: "Log fields",
      meta: typed ? `${fields.length} of ${Math.max(allFields.length, fields.length)}` : String(fields.length),
      rows: fields.map((key) => ({
        value: `k:${key}`,
        name: key,
        plain: false,
        tag: "field",
        amber: false,
        on: `k:${key}` === onValue,
      })),
    });
  }

  const others = opts.metrics.filter((metric) => metric.name !== pickedName);
  const metrics = typed ? others.filter((metric) => has(metric.name)) : others.slice(0, untypedMetrics);
  const total = Math.max(opts.metricTotal, opts.metrics.length);
  if (metrics.length > 0) {
    sections.push({
      id: "metrics",
      head: "Metrics",
      meta: typed
        ? `${metrics.length} of ${total} with points${metaWindow}`
        : `busiest ${metrics.length} of ${total}${metaWindow}`,
      rows: metrics.map((metric) => ({
        value: `m:${metric.name}`,
        name: metric.name,
        plain: false,
        tag: metric.kind,
        amber: false,
        on: false,
      })),
    });
  }

  const pickedHasPoints = pickedName !== null && (opts.picked?.points ?? 0) > 0;
  const unseen = total - metrics.length - (pickedHasPoints ? 1 : 0);
  const empty = typed && fields.length === 0 && metrics.length === 0 && base.length === 0;
  return {
    sections,
    more:
      !typed && unseen > 0
        ? `${unseen} more ${unseen === 1 ? "metric has" : "metrics have"} points in ${last} — type any part of a name to find one.`
        : "",
    emptyTitle: empty ? `Nothing named like “${opts.filter.trim()}” has points in ${last}.` : "",
    emptyBody: empty
      ? "A field or a metric is listed only while it has points in this window — one sent earlier is still stored. Widen the time range to look further back."
      : "",
    matches: typed ? fields.length + metrics.length : 0,
  };
}
