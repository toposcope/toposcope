import type { Context } from "hono";
import {
  resolveFilters,
  search,
  topValues,
  type SearchFilters,
} from "../query/index";
import { InvalidAggError, type SearchAggResult } from "../query/agg";
import { InvalidRangeError } from "../query/relative";
import { histogramIntervalMs } from "../query/histogram";
import { metricNames } from "../query/metric-series";
import { QueryCompileError } from "../query/compile";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import { InvalidMetricError, isMetricIdent, parseMetricRef } from "../shared/metric";
import {
  logQueryFor,
  metricAllowed,
  metricLabelsFor,
  parseNarrowing,
  type ShareScope,
} from "./scope";
import type { ShareRecord } from "./store";
import { durationMs, windowWithin, type ShareLimits } from "./limits";
import { originOf, rateTurn } from "./operator";
import { cacheMs, readShareCache, shareCacheKey, writeShareCache } from "./cache";
import { noteRead, noteRefused } from "./use";
import { panelReadParams, rawParamsUsed } from "./panels";

declare module "hono" {
  interface ContextVariableMap {
    share: ShareRecord;
    /** What opened the read: the share's secret, or a ticket a page holds (#227). */
    shareVia: "secret" | "ticket";
  }
}

type Refuse = { error: string; status: 400 | 404 };

/** The window params every share read takes, as Search takes them. */
function windowParams(p: Record<string, string | undefined>): Pick<SearchFilters, "from" | "to" | "range" | "step"> {
  return { from: p.from || undefined, to: p.to || undefined, range: p.range || undefined, step: p.step || undefined };
}

/**
 * The params a read uses (#266): a named panel's, with only the window left to the page; or the
 * page's own while the share allows raw params. With them off, only a panel name and a window pass.
 */
function readParams(c: Context): Record<string, string | undefined> | Response {
  const share = c.get("share");
  const raw = c.req.query();
  if (raw.panel) {
    const panel = share.panels.find((p) => p.name === raw.panel);
    if (!panel) {
      return refuse(c, `this share has no panel named ${raw.panel}`, 404);
    }
    if (!share.raw_params) {
      const extra = rawParamsUsed(raw);
      if (extra.length) {
        return refuse(c, `this share takes a panel name and a window only, not ${extra.join(", ")}`, 400);
      }
    }
    return panelReadParams(panel, (k) => raw[k]);
  }
  if (!share.raw_params) {
    return refuse(c, "this share answers its named panels only: name one with panel=", 400);
  }
  return raw;
}

/** Log reads through a share are counts: a numeric attr's percentile or max could be an id. */
export const shareLogAggs = ["count", "rate"] as const;

export type SeriesPlan =
  | { kind: "metric"; filters: SearchFilters }
  | { kind: "logs"; agg: (typeof shareLogAggs)[number]; filters: SearchFilters };

/**
 * One series read under a share (#225): the scope is added here, on the server, and anything the
 * scope does not allow is refused before ClickHouse is asked. Events are never read.
 */
export function planSeries(
  scope: ShareScope,
  params: {
    metric?: string;
    agg?: string;
    ml?: string;
    split?: string;
    window: Pick<SearchFilters, "from" | "to" | "range" | "step">;
  },
): SeriesPlan | Refuse {
  const narrowing = parseNarrowing(scope, params.ml);
  if ("error" in narrowing) {
    return { error: narrowing.error, status: 400 };
  }
  const split = params.split?.trim().toLowerCase() || null;
  if (split && !scope.split.includes(split)) {
    return { error: `this share cannot split by ${split}`, status: 400 };
  }
  if (params.metric !== undefined && params.agg !== undefined) {
    return { error: "metric= or agg=, not both", status: 400 };
  }
  if (params.metric !== undefined) {
    const ref = parseMetricRef(params.metric);
    // Outside the scope reads as a name that does not exist.
    if (!ref || !metricAllowed(scope, ref.name)) {
      return { error: "no such metric", status: 404 };
    }
    const labels = metricLabelsFor(scope, narrowing);
    if ("error" in labels) {
      return { error: labels.error, status: 400 };
    }
    return {
      kind: "metric",
      filters: {
        ...params.window,
        metric: params.metric,
        ml: Object.entries(labels).map(([k, v]) => `${k}:${v}`).join(","),
        msplit: split ?? undefined,
        events: "0",
      },
    };
  }
  const agg = (params.agg ?? "count").trim().toLowerCase();
  if (!(shareLogAggs as readonly string[]).includes(agg)) {
    return { error: `logs read as ${shareLogAggs.join(" or ")} through a share`, status: 400 };
  }
  const q = logQueryFor(scope, narrowing);
  if (q === null) {
    return { error: "this share reads no logs", status: 404 };
  }
  if (split && split !== "level" && split !== "service" && split !== "host") {
    return { error: `a log series splits by level, service or host; ${split} is a Top-N key`, status: 400 };
  }
  return {
    kind: "logs",
    agg: agg as (typeof shareLogAggs)[number],
    filters: {
      ...params.window,
      q,
      split: (split ?? "none") as SearchFilters["split"],
      agg: agg === "rate" ? "rate" : undefined,
      events: "0",
    },
  };
}

/** What a metric series says, without the expression: that would state the scope. */
function seriesOnly(agg: SearchAggResult | undefined): Omit<SearchAggResult, "expr"> | null {
  if (!agg) {
    return null;
  }
  const { expr: _expr, ...rest } = agg;
  return rest;
}

function stepMs(filters: SearchFilters): number {
  const resolved = resolveFilters(filters);
  return histogramIntervalMs(resolved.from, resolved.to, resolved.step);
}

/** A read the share does not allow: counted and written down, then answered. */
function refuse(c: Context, error: string, status: 400 | 404): Response {
  noteRefused(c.get("share").name, originOf(c), c.req.path, error);
  return c.json({ error }, status);
}

/** The read's window inside the share's limits, or the refusal to answer with. */
function limitedWindow(c: Context, p: Record<string, string | undefined>): Pick<SearchFilters, "from" | "to" | "step"> | Response {
  const window = windowWithin(c.get("share").limits, windowParams(p));
  return "error" in window ? refuse(c, window.error, 400) : window;
}

function done(c: Context, body: unknown): Response {
  noteRead(c.get("share").name, originOf(c));
  return c.json(body);
}

function readError(c: Context, err: unknown): Response | null {
  if (
    err instanceof InvalidRangeError ||
    err instanceof InvalidAggError ||
    err instanceof InvalidMetricError ||
    err instanceof QueryCompileError
  ) {
    return refuse(c, err.message, 400);
  }
  return null;
}

/**
 * Every `GET` read under a share (#227): an answer read in the last moment is served again and
 * counted as cached, off the rate; otherwise the read takes a turn of the rate (#226) and a good
 * answer is kept until its next bar starts, or 30 seconds.
 */
export async function shareReadCache(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const share = c.get("share");
  const key = shareCacheKey(c.req.path, c.req.query());
  const hit = readShareCache(share.id, key);
  if (hit) {
    noteRead(share.name, originOf(c), true);
    return c.json(hit.body, 200, { "cache-control": `private, max-age=${Math.ceil(hit.leftMs / 1000)}`, vary: "Authorization" });
  }
  const limited = rateTurn(c);
  if (limited) {
    return limited;
  }
  await next();
  if (c.res.status !== 200) {
    return;
  }
  const body = (await c.res.clone().json()) as { step_ms?: number };
  const ms = cacheMs(Date.now(), body.step_ms);
  writeShareCache(share.id, key, body, ms);
  // Per credential in the browser: an expired ticket must not be handed a live ticket's answer.
  c.res.headers.set("cache-control", `private, max-age=${Math.ceil(ms / 1000)}`);
  c.res.headers.set("vary", "Authorization");
}

/** `GET /share/v1/series` — one metric series, or one log count or rate, inside the share's scope. */
export async function shareSeriesRoute(c: Context): Promise<Response> {
  const p = readParams(c);
  if (p instanceof Response) {
    return p;
  }
  const window = limitedWindow(c, p);
  if (window instanceof Response) {
    return window;
  }
  const plan = planSeries(c.get("share").scope, {
    metric: p.metric || undefined,
    agg: p.agg || undefined,
    ml: p.ml || undefined,
    split: p.split || undefined,
    window,
  });
  if ("error" in plan) {
    return refuse(c, plan.error, plan.status);
  }
  try {
    const result = await search(plan.filters);
    const head = { from: result.from, to: result.to, step_ms: stepMs(plan.filters) };
    if (plan.kind === "metric") {
      return done(c, { ...head, series: seriesOnly(result.agg) });
    }
    const refused = result.scan?.source === "refused" ? { refused: result.scan.reason } : {};
    const buckets = result.histogram.map((b) =>
      plan.filters.split === "none" ? { t: b.t, n: b.n } : { t: b.t, n: b.n, series: b.series },
    );
    return done(c, {
      ...head,
      agg: plan.agg,
      total: result.total,
      buckets,
      ...(plan.agg === "rate" ? { series: seriesOnly(result.agg) } : {}),
      ...refused,
    });
  } catch (err) {
    return readError(c, err) ?? Promise.reject(err);
  }
}

/** `GET /share/v1/top?key=` — the busiest values of a `split` key among the scope's log rows. */
export async function shareTopRoute(c: Context): Promise<Response> {
  const scope = c.get("share").scope;
  const p = readParams(c);
  if (p instanceof Response) {
    return p;
  }
  const key = (p.key ?? "").trim().toLowerCase();
  if (!scope.split.includes(key)) {
    return refuse(c, key ? `this share cannot count by ${key}` : "key is required", 400);
  }
  const narrowing = parseNarrowing(scope, p.ml);
  if ("error" in narrowing) {
    return refuse(c, narrowing.error, 400);
  }
  const q = logQueryFor(scope, narrowing);
  if (q === null) {
    return refuse(c, "this share reads no logs", 404);
  }
  const nRaw = p.n;
  const n = nRaw === undefined ? 10 : Number(nRaw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    return refuse(c, "n is 1–50", 400);
  }
  const window = limitedWindow(c, p);
  if (window instanceof Response) {
    return window;
  }
  try {
    // The window's total too (#239), so a donut's `other` is the rest of the whole; budgeted as volume is.
    const [values, volume] = await Promise.all([
      topValues({ from: window.from, to: window.to, q }, key, n),
      search({ from: window.from, to: window.to, q, split: "none", events: "0" }),
    ]);
    return done(c, { from: window.from ?? null, to: window.to ?? null, key, values, total: volume.total });
  } catch (err) {
    return readError(c, err) ?? Promise.reject(err);
  }
}

/** Values of one label among the scope's metric points, busiest first. */
async function metricLabelValues(opts: {
  names: string[];
  labels: Record<string, string>;
  key: string;
  from?: string;
  to?: string;
}): Promise<string[]> {
  if (opts.names.length === 0) {
    return [];
  }
  const params: Record<string, string> = {
    tenant_id: "default",
    names: JSON.stringify(opts.names.flatMap((name) => [name, `${name}.count`])),
    key: opts.key,
  };
  const where = ["tenant_id = {tenant_id:String}", "name IN JSONExtract({names:String}, 'Array(String)')"];
  if (opts.from) {
    where.push("ts >= parseDateTime64BestEffort({from:String})");
    params.from = opts.from;
  }
  if (opts.to) {
    where.push("ts <= parseDateTime64BestEffort({to:String})");
    params.to = opts.to;
  }
  Object.entries(opts.labels).forEach(([k, v], i) => {
    where.push(`labels[{lk${i}:String}] = {lv${i}:String}`);
    params[`lk${i}`] = k;
    params[`lv${i}`] = v;
  });
  const rows = await clickhouseQuery<{ v: string }>(
    `
    SELECT labels[{key:String}] AS v
    FROM metrics
    WHERE ${where.join(" AND ")} AND v != ''
    GROUP BY v
    ORDER BY count() DESC, v ASC
    LIMIT 50
  `,
    params,
  );
  return rows.map((row) => String(row.v));
}

/**
 * The names with points under the scope's labels in the window, a histogram's `.count` and `.sum`
 * as its own name; null when the scope has no labels and every allowed name is inside it.
 */
async function namesUnderLabels(labels: Record<string, string>, from?: string, to?: string): Promise<Set<string> | null> {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return null;
  }
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  if (from) {
    where.push("ts >= parseDateTime64BestEffort({from:String})");
    params.from = from;
  }
  if (to) {
    where.push("ts <= parseDateTime64BestEffort({to:String})");
    params.to = to;
  }
  entries.forEach(([k, v], i) => {
    where.push(`labels[{lk${i}:String}] = {lv${i}:String}`);
    params[`lk${i}`] = k;
    params[`lv${i}`] = v;
  });
  const rows = await clickhouseQuery<{ name: string }>(
    `SELECT DISTINCT name FROM metrics WHERE ${where.join(" AND ")} LIMIT 1000`,
    params,
  );
  return new Set(rows.map((row) => String(row.name).replace(/\.(count|sum)$/, "")));
}

/**
 * `GET /share/v1/names` — what a picker needs: the metric names the share can read in the window,
 * with kind and unit, and the values of its split and narrow keys inside the scope.
 */
export async function shareNamesRoute(c: Context): Promise<Response> {
  const scope = c.get("share").scope;
  const window = limitedWindow(c, c.req.query());
  if (window instanceof Response) {
    return window;
  }
  try {
    const resolved = { from: window.from, to: window.to };
    const listed = scope.metric_names.length === 0 ? null : await metricNames({ from: resolved.from, to: resolved.to });
    // A name the pattern allows but that has points only under other labels is not in the scope.
    const under = listed ? await namesUnderLabels(scope.metric_labels, resolved.from, resolved.to) : null;
    const metrics = (listed?.keys ?? [])
      .filter((row) => metricAllowed(scope, row.k) && (under === null || under.has(row.k)))
      .map(({ k, kind, unit, description }) => ({ name: k, kind, ...(unit ? { unit } : {}), ...(description ? { description } : {}) }));
    const keys = [...new Set([...scope.split, ...scope.narrow])];
    const values: Record<string, string[]> = {};
    const q = logQueryFor(scope, {});
    for (const key of keys) {
      const fromMetrics = await metricLabelValues({
        names: metrics.map((m) => m.name),
        labels: scope.metric_labels,
        key,
        from: resolved.from,
        to: resolved.to,
      });
      const fromLogs = q === null ? [] : (await topValues({ ...resolved, q }, key, 50)).map((v) => v.v);
      values[key] = [...new Set([...fromMetrics, ...fromLogs])].slice(0, 50);
    }
    return done(c, { from: resolved.from ?? null, to: resolved.to ?? null, metrics, logs: scope.logs !== null, values });
  } catch (err) {
    return readError(c, err) ?? Promise.reject(err);
  }
}

/** `GET /share/v1/panels/:name` — a named panel's definition, for the embed to draw it (#266). */
export function sharePanelRoute(c: Context): Response {
  const panel = c.get("share").panels.find((p) => p.name === c.req.param("name"));
  if (!panel) {
    return refuse(c, `this share has no panel named ${c.req.param("name") ?? ""}`, 404);
  }
  return c.json({ name: panel.name, params: panel.params, raw_params: c.get("share").raw_params });
}

/** The most metric names one latest read takes, the most labels it groups by, and the most rows it answers. */
export const maxLatestNames = 8;
export const maxLatestBy = 3;
export const maxLatestRows = 2000;

export type LatestPlan = {
  names: string[];
  by: string[];
  labels: Record<string, string>;
  lookback: string;
  from: string;
};

/**
 * A latest-value read under a share: the names the scope allows, the `narrow` keys to group by,
 * the scope's labels with the caller's narrowing, and how far back to look. Not a series, so the
 * lookback is held to `max_lookback`, not `max_range`.
 */
export function planLatest(
  scope: ShareScope,
  limits: ShareLimits,
  params: { metric?: string; by?: string; ml?: string; lookback?: string },
  now = Date.now(),
): LatestPlan | Refuse {
  const names = [...new Set((params.metric ?? "").split(",").map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) {
    return { error: "metric is required: one name, or up to 8 separated by commas", status: 400 };
  }
  if (names.length > maxLatestNames) {
    return { error: `at most ${maxLatestNames} metrics in one read`, status: 400 };
  }
  for (const name of names) {
    // A reading (`p99:`) or a name outside the scope reads as a name that does not exist.
    if (!isMetricIdent(name) || !metricAllowed(scope, name)) {
      return { error: `no such metric: ${name}`, status: 404 };
    }
  }
  const by = [...new Set((params.by ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (by.length === 0) {
    return { error: "by is required: the label to group by, or up to 3 separated by commas", status: 400 };
  }
  if (by.length > maxLatestBy) {
    return { error: `by takes at most ${maxLatestBy} labels`, status: 400 };
  }
  for (const key of by) {
    if (!scope.narrow.includes(key)) {
      return { error: `this share cannot group by ${key}: it is not a narrow key`, status: 400 };
    }
  }
  const narrowing = parseNarrowing(scope, params.ml);
  if ("error" in narrowing) {
    return { error: narrowing.error, status: 400 };
  }
  for (const key of by) {
    if (key in narrowing) {
      return { error: `${key} is both grouped by and narrowed`, status: 400 };
    }
  }
  const labels = metricLabelsFor(scope, narrowing);
  if ("error" in labels) {
    return { error: labels.error, status: 400 };
  }
  const lookback = (params.lookback ?? "").trim();
  if (!lookback) {
    return { error: "lookback is required: how far back to look, as 30d or 400d", status: 400 };
  }
  const ms = durationMs(lookback);
  if (ms === null) {
    return { error: `lookback=${lookback} is not a duration (30d, 12h, 2w)`, status: 400 };
  }
  if (ms > durationMs(limits.max_lookback)!) {
    return { error: `this share reaches back ${limits.max_lookback}`, status: 400 };
  }
  return { names, by, labels, lookback, from: new Date(now - ms).toISOString() };
}

/**
 * The newest point per value of the `by` labels, per name: one pass over the names' own part of
 * `metrics` (its ORDER BY is tenant, name, ts). One row past the cap is read, so a read that
 * would be cut short is refused instead.
 */
export async function latestRows(plan: LatestPlan): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    tenant_id: "default",
    names: JSON.stringify(plan.names),
    from: plan.from,
  };
  const where = [
    "tenant_id = {tenant_id:String}",
    "name IN JSONExtract({names:String}, 'Array(String)')",
    "ts >= parseDateTime64BestEffort({from:String})",
  ];
  Object.entries(plan.labels).forEach(([k, v], i) => {
    where.push(`labels[{lk${i}:String}] = {lv${i}:String}`);
    params[`lk${i}`] = k;
    params[`lv${i}`] = v;
  });
  const cols = plan.by.map((key, i) => {
    params[`b${i}`] = key;
    where.push(`labels[{b${i}:String}] != ''`);
    return `labels[{b${i}:String}] AS b${i}`;
  });
  const groups = plan.by.map((_, i) => `b${i}`);
  const rows = await clickhouseQuery<Record<string, string | number>>(
    `
    SELECT name AS metric, ${cols.join(", ")}, argMax(value, ts) AS value, max(ts) AS at
    FROM metrics
    WHERE ${where.join(" AND ")}
    GROUP BY metric, ${groups.join(", ")}
    ORDER BY metric, ${groups.join(", ")}
    LIMIT ${maxLatestRows + 1}
    SETTINGS max_rows_to_group_by = ${maxLatestRows + 1}, group_by_overflow_mode = 'break'
  `,
    params,
  );
  return rows.map((row) => {
    const out: Record<string, unknown> = { metric: String(row.metric) };
    plan.by.forEach((key, i) => {
      out[key] = String(row[`b${i}`]);
    });
    out.value = Number(row.value);
    out.at = toIsoTimestamp(String(row.at));
    return out;
  });
}

/**
 * `GET /share/v1/latest?metric=&by=&lookback=` — the newest point of each value of the `by`
 * labels, for totals a sender re-sends as gauges (a day's sign-ups, a cohort's count). One read.
 */
export async function shareLatestRoute(c: Context): Promise<Response> {
  const share = c.get("share");
  if (!share.raw_params) {
    return refuse(c, "this share answers its named panels only: name one with panel=", 400);
  }
  const p = c.req.query();
  const plan = planLatest(share.scope, share.limits, { metric: p.metric, by: p.by, ml: p.ml, lookback: p.lookback });
  if ("error" in plan) {
    return refuse(c, plan.error, plan.status);
  }
  try {
    const rows = await latestRows(plan);
    if (rows.length > maxLatestRows) {
      return refuse(
        c,
        `more than ${maxLatestRows.toLocaleString("en-US")} rows: narrow with ml=, fewer metrics or a shorter lookback`,
        400,
      );
    }
    return done(c, { metrics: plan.names, by: plan.by, lookback: plan.lookback, from: plan.from, rows });
  } catch (err) {
    return readError(c, err) ?? Promise.reject(err);
  }
}
