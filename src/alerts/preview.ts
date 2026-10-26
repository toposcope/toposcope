import type { Context } from "hono";
import { search } from "../query";
import { parseSearchAgg } from "../query/agg";
import { parseRangeMs } from "../query/relative";
import { parseMonitorMeasure, parseOpensWhen, type MonitorMeasure, type OpensWhen } from "../shared/monitor";
import { readsFail } from "./monitor";

/**
 * Where a saved-search monitor would have opened over the last 24 h (#264, frame 26h): the hunt's
 * series at the monitor's own window, the same comparison the evaluator makes, and the stretches
 * that comparison would have opened. Nothing is stored.
 */
export const previewWindows = { "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 } as const;
export type PreviewWindow = keyof typeof previewWindows;
const dayMs = 24 * 60 * 60_000;

export type PreviewPoint = { t: string; v: number };
export type PreviewStretch = { from: string; to: string | null };
export type MonitorPreview = {
  series: PreviewPoint[];
  threshold: number;
  opens_when: OpensWhen;
  opens: PreviewStretch[];
  open_ms: number;
  /** A higher (or, for fewer than, lower) threshold that would have opened fewer times. */
  next: { threshold: number; opens: number } | null;
  refused: string | null;
};

/** Consecutive failing points are one stretch; a stretch still failing at the end is open. */
export function stretchesOf(series: PreviewPoint[], opensWhen: OpensWhen, threshold: number, stepMs: number): PreviewStretch[] {
  const out: PreviewStretch[] = [];
  let start: string | null = null;
  series.forEach((p, i) => {
    const fail = readsFail(opensWhen, p.v, threshold);
    if (fail && start === null) {
      start = p.t;
    }
    if (!fail && start !== null) {
      out.push({ from: start, to: p.t });
      start = null;
    }
    if (i === series.length - 1 && start !== null) {
      out.push({ from: start, to: null });
    }
  });
  void stepMs;
  return out;
}

/** Every bar of the window on the step grid; bars the read left out are 0 for a count, absent for a stat. */
export function fillSteps(points: PreviewPoint[], fromMs: number, toMs: number, stepMs: number, zeros: boolean): PreviewPoint[] {
  if (!zeros) {
    return points;
  }
  const by = new Map(points.map((p) => [Date.parse(p.t), p.v]));
  const out: PreviewPoint[] = [];
  for (let t = Math.floor(fromMs / stepMs) * stepMs; t < toMs; t += stepMs) {
    out.push({ t: new Date(t).toISOString(), v: by.get(t) ?? 0 });
  }
  return out;
}

/** The nearest round threshold past this one that would have opened fewer times, if any does. */
export function nextThreshold(series: PreviewPoint[], opensWhen: OpensWhen, threshold: number, stepMs: number): { threshold: number; opens: number } | null {
  const now = stretchesOf(series, opensWhen, threshold, stepMs).length;
  if (now === 0) {
    return null;
  }
  const steps = opensWhen === "fewer_than" ? [0.75, 0.5, 0.25] : [1.5, 2, 3, 5, 10];
  for (const k of steps) {
    const raw = threshold * k;
    const t = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    if (t === threshold || t <= 0) {
      continue;
    }
    const n = stretchesOf(series, opensWhen, t, stepMs).length;
    if (n < now) {
      return { threshold: t, opens: n };
    }
  }
  return null;
}

/** A share's bars (#279): each bar's matching rows over every row in it, in percent; a bar with no rows is left out. */
export function shareSteps(matching: PreviewPoint[], all: PreviewPoint[]): PreviewPoint[] {
  const total = new Map(all.map((p) => [p.t, p.v]));
  return matching.flatMap((p) => {
    const t = total.get(p.t) ?? 0;
    return t > 0 ? [{ t: p.t, v: (100 * p.v) / t }] : [];
  });
}

export async function monitorPreview(input: { q: string; agg: string | null; opensWhen: OpensWhen; threshold: number; window: PreviewWindow; measure?: MonitorMeasure; nowMs?: number }): Promise<MonitorPreview> {
  const nowMs = input.nowMs ?? Date.now();
  const stepMs = previewWindows[input.window];
  const span = { from: new Date(nowMs - dayMs).toISOString(), to: new Date(nowMs).toISOString(), step: input.window, events: "0", split: "none" as const };
  const share = input.measure === "share";
  const [res, everything] = await Promise.all([
    search({ q: input.q, ...span, ...(input.agg && !share ? { agg: input.agg } : {}) }),
    share ? search({ q: "", ...span }) : Promise.resolve(null),
  ]);
  const refused = res.scan?.histogram
    ? res.scan.reason
    : everything?.scan?.histogram
      ? everything.scan.reason
      : input.agg && !share && res.agg?.source === "refused"
        ? (res.agg.reason ?? "refused")
        : null;
  const sparse: PreviewPoint[] = input.agg && !share && res.agg && res.agg.source !== "refused"
    ? res.agg.buckets.map((b) => ({ t: b.t, v: b.v }))
    : res.histogram.map((b) => ({ t: b.t, v: b.n }));
  // A bar with no rows is a 0, not a gap: "fewer than" must see it (and a count reads 0 there).
  const counted = fillSteps(sparse, nowMs - dayMs, nowMs, stepMs, !input.agg || share);
  const series = share && everything
    ? shareSteps(counted, fillSteps(everything.histogram.map((b) => ({ t: b.t, v: b.n })), nowMs - dayMs, nowMs, stepMs, true))
    : counted;
  const opens = refused ? [] : stretchesOf(series, input.opensWhen, input.threshold, stepMs);
  const open_ms = opens.reduce((sum, s) => sum + ((s.to ? Date.parse(s.to) : nowMs) - Date.parse(s.from)), 0);
  return {
    series,
    threshold: input.threshold,
    opens_when: input.opensWhen,
    opens,
    open_ms,
    next: refused ? null : nextThreshold(series, input.opensWhen, input.threshold, stepMs),
    refused,
  };
}

/** `GET /api/monitors/preview?q=&agg=&opens_when=&threshold=&window=5m|15m|1h`. */
export async function monitorPreviewRoute(c: Context): Promise<Response> {
  const q = c.req.query("q") ?? "";
  const aggRaw = c.req.query("agg")?.trim() || null;
  const opensWhen = parseOpensWhen(c.req.query("opens_when") ?? "at_least");
  const threshold = Number(c.req.query("threshold"));
  const windowRaw = c.req.query("window") ?? "5m";
  const measure = parseMonitorMeasure(c.req.query("measure") ?? "series");
  if (!measure) {
    return c.json({ error: "measure is series or share" }, 400);
  }
  if (!opensWhen) {
    return c.json({ error: "opens_when is at_least or fewer_than" }, 400);
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return c.json({ error: "threshold is a positive number" }, 400);
  }
  if (!(windowRaw in previewWindows) || parseRangeMs(windowRaw) === null) {
    return c.json({ error: "window is 5m, 15m or 1h" }, 400);
  }
  try {
    if (aggRaw) {
      parseSearchAgg(aggRaw);
    }
    return c.json(await monitorPreview({ q, agg: aggRaw, opensWhen, threshold, window: windowRaw as PreviewWindow, measure }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "preview failed" }, 400);
  }
}
