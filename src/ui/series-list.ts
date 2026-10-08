import {
  defaultHistogramReading,
  histogramReadings,
  type HistogramReading,
} from "../shared/metric";
import { pickerNumericKeys, type SeriesPick } from "./agg-picker";

/** How an ingested metric's bars are read. */
export type MetricKindName = "gauge" | "counter" | "histogram";

export type MetricEntry = {
  name: string;
  kind: MetricKindName;
  points: number;
  /** For the `.count` or `.sum` an older link carries: the histogram it is a reading of. */
  of?: string;
  reading?: HistogramReading;
};

/** A picked metric as it is shown: under which name, of what kind, read how. */
export type MetricView = { name: string; kind: MetricKindName; reading: HistogramReading | null };

/**
 * The series result knows best, then the window's list, then the link itself.
 * A link that carries a histogram's `.count` or `.sum` is shown as that
 * reading of the histogram.
 */
export function metricView(
  pick: { name: string; reading?: HistogramReading | null },
  entry?: MetricEntry | null,
  result?: { kind?: MetricKindName; reading?: HistogramReading; metric?: string } | null,
): MetricView {
  const kind = result?.kind ?? entry?.kind ?? "gauge";
  if (kind !== "histogram") {
    return { name: pick.name, kind, reading: null };
  }
  return {
    name: result?.metric ?? entry?.of ?? pick.name,
    kind,
    reading: result?.reading ?? entry?.reading ?? pick.reading ?? defaultHistogramReading,
  };
}

/** What each reading of a histogram measures, as its menu says it. */
export const readingMenu: ReadonlyArray<{ reading: HistogramReading; words: string }> = histogramReadings.map(
  (reading) => ({
    reading,
    words: {
      count: "how many were observed",
      sum: "sum of observations",
      avg: "mean of observations",
      p50: "median",
      p90: "90th percentile",
      p99: "99th percentile",
    }[reading],
  }),
);

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
 * How a metric's bar is read, as printed beside the name: a gauge's `avg`, a
 * counter's sum with the bar width, because the width is part of the number,
 * and a histogram's chosen reading.
 */
export function metricReading(
  kind: MetricKindName,
  step: string,
  compact = false,
  reading: HistogramReading | null = null,
): string {
  if (kind === "histogram") {
    return reading ?? defaultHistogramReading;
  }
  if (kind === "gauge") {
    return "avg";
  }
  return step.length === 0 ? "sum" : compact ? `sum/${step}` : `sum / ${step}`;
}

/** What that reading means for one bar, in words. */
export function readingWords(
  kind: MetricKindName,
  step: string,
  reading: HistogramReading | null = null,
): string {
  const bar = step.length > 0 ? `this ${step}` : "this bar";
  if (kind === "histogram") {
    const what = {
      count: `observed in ${bar}`,
      sum: `sum of what was observed in ${bar}`,
      avg: `mean of what was observed in ${bar}`,
      p50: `median of ${bar}`,
      p90: `90th percentile of ${bar}`,
      p99: `99th percentile of ${bar}`,
    }[reading ?? defaultHistogramReading];
    return `histogram · ${what}`;
  }
  return kind === "gauge"
    ? `gauge · average level in ${bar}`
    : `counter · arrived in ${bar} — not a level`;
}

/** A Stat card's note: one number for the whole window. */
export function statWords(
  kind: MetricKindName,
  window: string,
  reading: HistogramReading | null = null,
): string {
  if (kind === "histogram") {
    const within = window.length > 0 ? `in the last ${window}` : "in this window";
    const read = reading ?? defaultHistogramReading;
    return read === "count"
      ? `observations ${within} · histogram`
      : `${read === "avg" ? "mean" : read} of every observation ${within} · histogram`;
  }
  const over = window.length > 0 ? `over the last ${window}` : "over this window";
  return kind === "gauge" ? `avg level ${over} · gauge` : `sum ${over} · counter`;
}

/** What picking a metric writes: its name, and for a histogram the reading it starts with. */
function metricValue(name: string, kind: MetricKindName): string {
  return kind === "histogram" ? `m:${defaultHistogramReading}:${name}` : `m:${name}`;
}

export type SeriesRow = {
  /** What `applySeriesSelect` takes: "", "rate", "k:<field>", "m:<metric>", "m:<reading>:<histogram>". */
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

  // An older link's `<name>.count` is listed as the histogram it reads.
  const pickedName = opts.pick.kind === "metric" ? (opts.picked?.of ?? opts.pick.name) : null;
  if (pickedName) {
    const kind = opts.picked?.kind ?? "gauge";
    const quiet = !opts.picked || opts.picked.points === 0;
    sections.push({
      id: "picked",
      head: "Picked",
      meta: quiet ? "" : "stays here while picked",
      rows: [
        {
          value: metricValue(pickedName, kind),
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
        value: metricValue(metric.name, metric.kind),
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
