/**
 * The embedded panel (#227, frames 23a–23f): what it asks for, and what it says. Pure, so the
 * states are tested apart from the page.
 */

export type EmbedTheme = "dark" | "light";

/** What the frame draws (#235). Every kind reads only what `/share/v1` allows. */
export const embedCharts = ["line", "bars", "stacked", "stat", "top"] as const;
export type EmbedChart = (typeof embedCharts)[number];

export type EmbedParams = {
  ticket: string;
  chart: EmbedChart;
  /** The read the frame makes: `/share/v1/series`, or `/share/v1/top` for a Top-N. */
  path: "/share/v1/series" | "/share/v1/top";
  /** Its query: the panel's own params, as Search writes them. */
  query: URLSearchParams;
  title: string;
  /** `fleet_cpu_seconds · p99 · s`: what the panel reads, under its title. */
  what: string;
  theme: EmbedTheme;
  /** When the ticket stops, read from the ticket itself. */
  ticketUntil: number | null;
};

const seriesKeys = ["metric", "ml", "split", "agg", "range", "from", "to", "step"] as const;
const topKeys = ["key", "n", "ml", "range", "from", "to"] as const;

export function parseEmbedParams(search: string): EmbedParams {
  const url = new URLSearchParams(search);
  const ticket = url.get("ticket") ?? "";
  const chartRaw = url.get("chart") ?? "line";
  const chart: EmbedChart = (embedCharts as readonly string[]).includes(chartRaw) ? (chartRaw as EmbedChart) : "line";
  const query = new URLSearchParams();
  for (const key of chart === "top" ? topKeys : seriesKeys) {
    const v = url.get(key);
    if (v) query.set(key, v);
  }
  const reading = url.get("reading");
  const metric = url.get("metric");
  if (metric && reading && !metric.includes(":")) {
    query.set("metric", `${reading}:${metric}`);
  }
  const name =
    chart === "top" ? `top ${url.get("n") || "10"} by ${url.get("key") ?? ""}` : metric ? metric.replace(/^[a-z0-9]+:/, "") : `logs · ${url.get("agg") || "count"}`;
  const what = [name, reading ?? (metric?.includes(":") ? metric.split(":")[0] : null), url.get("split") ? `split ${url.get("split")}` : null]
    .filter(Boolean)
    .join(" · ");
  const until = Number(ticket.split(".")[1]);
  return {
    ticket,
    chart,
    path: chart === "top" ? "/share/v1/top" : "/share/v1/series",
    query,
    title: url.get("title") || name,
    what,
    theme: url.get("theme") === "light" ? "light" : "dark",
    ticketUntil: Number.isSafeInteger(until) && until > 0 ? until : null,
  };
}

export type SeriesBody = {
  from: string | null;
  to: string | null;
  step_ms: number;
  series?: {
    unit?: string;
    buckets: Array<{ t: string; v: number }>;
    splits?: Array<{ key: string; buckets: Array<{ t: string; v: number }> }>;
    source?: string;
    reason?: string;
  } | null;
  agg?: "count" | "rate";
  total?: number;
  buckets?: Array<{ t: string; n: number; series?: Record<string, number> }>;
  refused?: string;
  /** A Top-N's answer (`/share/v1/top`). */
  key?: string;
  values?: Array<{ v: string; n: number }>;
};

export type EmbedState =
  | { kind: "loading" }
  | { kind: "painted"; body: SeriesBody; readAt: number }
  | { kind: "stale"; body: SeriesBody | null; readAt: number | null; since: number }
  | { kind: "expired" }
  | { kind: "refused"; error: string };

/** What an answer, or a failed fetch, turns the panel into. A paint is kept through a failure. */
export function nextEmbedState(
  prev: EmbedState,
  answer: { status: number; body: unknown } | { failed: true },
  now: number,
): EmbedState {
  const last = prev.kind === "painted" ? prev : prev.kind === "stale" ? prev : null;
  if ("failed" in answer || answer.status === 429 || answer.status >= 500) {
    return { kind: "stale", body: last?.body ?? null, readAt: last?.readAt ?? null, since: prev.kind === "stale" ? prev.since : now };
  }
  if (answer.status === 401) {
    return { kind: "expired" };
  }
  if (answer.status !== 200) {
    const error = (answer.body as { error?: string } | null)?.error ?? `refused (${answer.status})`;
    return { kind: "refused", error };
  }
  return { kind: "painted", body: answer.body as SeriesBody, readAt: now };
}

/** The frame polls at its bar width, never faster than every 30 seconds. */
export function pollMs(body: SeriesBody | null): number {
  return Math.max(30_000, body?.step_ms ?? 0);
}

/**
 * A series answer as the app's metric panel reads it (#235): a metric as it came, a log count or
 * rate as one line (or one per split value) of its buckets.
 */
export function embedAggResult(body: SeriesBody): {
  expr: string;
  source: "metric";
  buckets: Array<{ t: string; v: number }>;
  stat: number | null;
  unit?: string;
  kind?: "gauge" | "counter" | "histogram";
  reading?: string;
  splits?: Array<{ key: string; buckets: Array<{ t: string; v: number }>; stat: number | null }>;
} {
  if (body.series && body.series.source !== "refused") {
    return { expr: "", ...(body.series as object), source: "metric" } as ReturnType<typeof embedAggResult>;
  }
  const buckets = body.buckets ?? [];
  const keys = [...new Set(buckets.flatMap((b) => Object.keys(b.series ?? {})))];
  const total = buckets.reduce((sum, b) => sum + b.n, 0);
  return {
    expr: "",
    source: "metric",
    buckets: buckets.map((b) => ({ t: b.t, v: b.n })),
    stat: total,
    kind: "counter",
    ...(keys.length > 0
      ? { splits: keys.map((key) => ({ key, stat: null, buckets: buckets.map((b) => ({ t: b.t, v: b.series?.[key] ?? 0 })) })) }
      : {}),
  };
}

/** What the frame tells its parent page, so a host can show its own fallback. */
export function embedMessage(state: EmbedState): "toposcope:ready" | "toposcope:stale" | "toposcope:expired" | null {
  return state.kind === "expired" ? "toposcope:expired" : state.kind === "stale" ? "toposcope:stale" : state.kind === "loading" ? null : "toposcope:ready";
}
