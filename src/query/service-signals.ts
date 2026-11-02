import type { Context } from "hono";
import { clickhouseQuery } from "../shared/clickhouse";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";

/** How many span names and metric names the answer lists, busiest first. */
export const SIGNAL_SPAN_NAMES = 5;
export const SIGNAL_METRIC_NAMES = 20;

export type ServiceSignals = {
  service: string;
  from: string;
  to: string;
  /** Spans the service sent in the window. */
  spans: number;
  /** Its busiest span names. */
  span_names: string[];
  /** How many metric names it sent points for, a histogram counted once. */
  metrics: number;
  /** Its busiest metric names, a histogram's `<name>.count` and `<name>.sum` folded into `<name>`. */
  metric_names: string[];
  /** Which of those names are histograms. */
  histograms: string[];
};

const settings = "SETTINGS max_execution_time = 8";

const window = `ts >= parseDateTime64BestEffort({from:String}) AND ts <= parseDateTime64BestEffort({to:String})`;

export const serviceSignalsSql = {
  spans: `
    SELECT name, count() AS n, sum(count()) OVER () AS total
    FROM spans
    WHERE tenant_id = 'default' AND service = {service:String} AND ${window}
    GROUP BY name
    ORDER BY n DESC, name ASC
    LIMIT ${SIGNAL_SPAN_NAMES}
    ${settings}
  `,
  metrics: `
    SELECT name, count() AS n
    FROM metrics
    WHERE tenant_id = 'default' AND labels['service'] = {service:String} AND ${window}
    GROUP BY name
    ${settings}
  `,
  histograms: `
    SELECT DISTINCT name
    FROM metric_buckets
    WHERE tenant_id = 'default' AND labels['service'] = {service:String} AND ${window}
    ${settings}
  `,
};

type Count = { name: string; n: string | number };

/**
 * A service's metric names as the Series list shows them: a histogram's `<name>.count` and
 * `<name>.sum` are the one name `<name>`, counted by its count's points. Busiest first.
 */
export function foldMetricNames(rows: Count[], histogramNames: readonly string[]): Array<{ name: string; n: number; histogram: boolean }> {
  const hist = new Set(histogramNames);
  const out = new Map<string, { name: string; n: number; histogram: boolean }>();
  for (const row of rows) {
    const n = Number(row.n);
    let name = row.name;
    let histogram = false;
    if (name.endsWith(".sum") && hist.has(name.slice(0, -4))) {
      continue;
    }
    if (name.endsWith(".count") && hist.has(name.slice(0, -6))) {
      name = name.slice(0, -6);
      histogram = true;
    }
    const seen = out.get(name);
    out.set(name, { name, n: (seen?.n ?? 0) + n, histogram: histogram || (seen?.histogram ?? false) });
  }
  for (const name of hist) {
    if (!out.has(name)) {
      out.set(name, { name, n: 0, histogram: true });
    }
  }
  return [...out.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

function resolveWindow(from: string | undefined, to: string | undefined, range: string | undefined): { from: string; to: string } {
  if (range) {
    const resolved = resolveRange(range);
    if (!resolved) {
      throw new InvalidRangeError(range);
    }
    const clamped = clampSearchSpan(resolved.from, resolved.to);
    return { from: clamped.from ?? resolved.from, to: clamped.to ?? resolved.to };
  }
  if (!from || !to) {
    throw new InvalidRangeError("from/to or range");
  }
  const clamped = clampSearchSpan(from, to);
  return { from: clamped.from ?? from, to: clamped.to ?? to };
}

/** What one service sent besides logs in a window: its spans and its metric names (#420). */
export async function serviceSignals(service: string, from: string, to: string): Promise<ServiceSignals> {
  const params = { service, from, to };
  const [spans, metrics, histograms] = await Promise.all([
    clickhouseQuery<Count & { total: string | number }>(serviceSignalsSql.spans, params),
    clickhouseQuery<Count>(serviceSignalsSql.metrics, params),
    clickhouseQuery<{ name: string }>(serviceSignalsSql.histograms, params),
  ]);
  const folded = foldMetricNames(metrics, histograms.map((row) => row.name));
  const listed = folded.slice(0, SIGNAL_METRIC_NAMES);
  return {
    service,
    from,
    to,
    spans: Number(spans[0]?.total ?? 0),
    span_names: spans.map((row) => row.name),
    metrics: folded.length,
    metric_names: listed.map((row) => row.name),
    histograms: listed.filter((row) => row.histogram).map((row) => row.name),
  };
}

/** `GET /api/service-signals?service=&range=`: a service's spans and metric names in a window. */
export async function serviceSignalsRoute(c: Context): Promise<Response> {
  const service = c.req.query("service")?.trim() ?? "";
  if (!service) {
    return c.json({ error: "service is required" }, 400);
  }
  try {
    const window = resolveWindow(c.req.query("from") ?? undefined, c.req.query("to") ?? undefined, c.req.query("range") ?? undefined);
    return c.json(await serviceSignals(service, window.from, window.to));
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}
