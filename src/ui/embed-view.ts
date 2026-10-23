/**
 * The embedded panel (#227, frames 23a–23f): what it asks for, and what it says. Pure, so the
 * states are tested apart from the page.
 */

export type EmbedTheme = "dark" | "light";

export type EmbedParams = {
  ticket: string;
  /** The `/share/v1/series` query: the panel's own params, as Search writes them. */
  query: URLSearchParams;
  title: string;
  /** `fleet_cpu_seconds · p99 · s`: what the panel reads, under its title. */
  what: string;
  theme: EmbedTheme;
  /** When the ticket stops, read from the ticket itself. */
  ticketUntil: number | null;
};

const seriesKeys = ["metric", "ml", "split", "agg", "range", "from", "to", "step"] as const;

export function parseEmbedParams(search: string): EmbedParams {
  const url = new URLSearchParams(search);
  const ticket = url.get("ticket") ?? "";
  const query = new URLSearchParams();
  for (const key of seriesKeys) {
    const v = url.get(key);
    if (v) query.set(key, v);
  }
  const reading = url.get("reading");
  const metric = url.get("metric");
  if (metric && reading && !metric.includes(":")) {
    query.set("metric", `${reading}:${metric}`);
  }
  const name = metric ? metric.replace(/^[a-z0-9]+:/, "") : `logs · ${url.get("agg") || "count"}`;
  const what = [name, reading ?? (metric?.includes(":") ? metric.split(":")[0] : null), url.get("split") ? `split ${url.get("split")}` : null]
    .filter(Boolean)
    .join(" · ");
  const until = Number(ticket.split(".")[1]);
  return {
    ticket,
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
  buckets?: Array<{ t: string; n: number; series?: Record<string, number> }>;
  refused?: string;
};

export type EmbedLine = { key: string; points: Array<{ t: number; v: number }> };

/** One line, or one per split value, from either kind of answer. */
export function embedLines(body: SeriesBody): { lines: EmbedLine[]; unit: string } {
  const pts = (bs: Array<{ t: string; v: number }>) => bs.map((b) => ({ t: Date.parse(b.t), v: b.v }));
  if (body.series && body.series.source !== "refused") {
    const lines = body.series.splits
      ? body.series.splits.map((s) => ({ key: s.key, points: pts(s.buckets) }))
      : [{ key: "", points: pts(body.series.buckets) }];
    return { lines, unit: body.series.unit ?? (body.agg === "rate" ? "/s" : "") };
  }
  const buckets = body.buckets ?? [];
  const keys = [...new Set(buckets.flatMap((b) => Object.keys(b.series ?? {})))];
  if (keys.length > 0) {
    return {
      lines: keys.map((key) => ({ key, points: buckets.map((b) => ({ t: Date.parse(b.t), v: b.series?.[key] ?? 0 })) })),
      unit: "",
    };
  }
  return { lines: [{ key: "", points: buckets.map((b) => ({ t: Date.parse(b.t), v: b.n })) }], unit: "" };
}

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

/** What the frame tells its parent page, so a host can show its own fallback. */
export function embedMessage(state: EmbedState): "toposcope:ready" | "toposcope:stale" | "toposcope:expired" | null {
  return state.kind === "expired" ? "toposcope:expired" : state.kind === "stale" ? "toposcope:stale" : state.kind === "loading" ? null : "toposcope:ready";
}

/** Axis times: `HH:MM`, `HH:MM:SS` under 15 minutes, `MM-DD` once four ticks are a day or more apart. */
export function tickLabel(t: number, spanMs: number): string {
  const iso = new Date(t).toISOString();
  return spanMs >= 4 * 86_400_000 ? iso.slice(5, 10) : spanMs < 15 * 60_000 ? iso.slice(11, 19) : iso.slice(11, 16);
}

/** A round top for the axis, and its four gridlines' values from it down to 0. */
export function axisSteps(peak: number): number[] {
  if (!(peak > 0)) {
    return [1, 0.5, 0];
  }
  const raw = peak / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(peak / step) * step;
  const out: number[] = [];
  for (let v = top; v > -step / 2; v -= step) out.push(Number(v.toPrecision(12)));
  return out;
}
