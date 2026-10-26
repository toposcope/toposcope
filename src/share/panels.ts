import { parseMetricLabels } from "../shared/metric";
import type { ShareScope } from "./scope";

/**
 * Named panels on a share (#266, frame 26k; picked over the page-composed model on 2026-10-26).
 * A panel is the embed tag's own params, kept under a name: a page names it with `data-panel=`,
 * and every page follows when the operator edits it here. The share's fence is derived from its
 * panels; `raw_params` (on by default) still lets a page pass its own params within that fence.
 */
export type SharePanel = { name: string; params: Record<string, string>; from?: string };

/** What a panel may hold: the tag's panel params, never the ticket or the page's theme. */
export const panelParamKeys = ["chart", "metric", "reading", "ml", "split", "agg", "key", "n", "range", "step", "title"] as const;
const charts = ["line", "bars", "stacked", "stat", "top", "donut"];
export const maxSharePanels = 24;
const panelNameRe = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function parseSharePanels(raw: unknown): SharePanel[] | { error: string } {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return { error: "panels is a list" };
  }
  if (raw.length > maxSharePanels) {
    return { error: `a share holds ${maxSharePanels} panels at most` };
  }
  const out: SharePanel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "a panel is { name, params }" };
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!panelNameRe.test(name)) {
      return { error: `panel name ${name || "(empty)"}: lower-case letters, digits, . _ -, up to 48` };
    }
    if (seen.has(name)) {
      return { error: `two panels are named ${name}` };
    }
    seen.add(name);
    const paramsRaw = rec.params && typeof rec.params === "object" && !Array.isArray(rec.params) ? (rec.params as Record<string, unknown>) : null;
    if (!paramsRaw) {
      return { error: `panel ${name}: params is an object` };
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(paramsRaw)) {
      if (!(panelParamKeys as readonly string[]).includes(k)) {
        return { error: `panel ${name}: ${k} is not a panel param` };
      }
      if (typeof v !== "string" && typeof v !== "number") {
        return { error: `panel ${name}: ${k} is a string` };
      }
      const s = String(v).trim();
      if (s) {
        params[k] = s.slice(0, 500);
      }
    }
    const chart = params.chart ?? "line";
    if (!charts.includes(chart)) {
      return { error: `panel ${name}: chart is one of ${charts.join(", ")}` };
    }
    if ((chart === "top" || chart === "donut") && !params.key) {
      return { error: `panel ${name}: a top or donut panel names its key` };
    }
    const from = typeof rec.from === "string" && rec.from.trim() ? rec.from.trim().slice(0, 120) : undefined;
    out.push({ name, params, ...(from ? { from } : {}) });
  }
  return out;
}

function metricOf(p: SharePanel): string | null {
  const m = p.params.metric;
  return m ? m.replace(/^[a-z0-9]+:/, "") : null;
}

function isLogPanel(p: SharePanel): boolean {
  return !metricOf(p);
}

/**
 * The fence the panels need (26k "derived from the panels"): their metric names, the labels they
 * all read under, the keys they split or count by, and the label keys they narrow by. Logs keep the
 * `q` given, since a panel has no `q` of its own (per-widget `q` stays out).
 */
export function deriveShareScope(panels: SharePanel[], logs: string | null): ShareScope | { error: string } {
  if (panels.some(isLogPanel) && !logs) {
    return { error: "a log panel reads the share's logs: give scope.logs (a q) or logs" };
  }
  const names = [...new Set(panels.map(metricOf).filter((m): m is string => Boolean(m)))].sort();
  const labelSets = panels.filter((p) => metricOf(p)).map((p) => parseMetricLabels(p.params.ml ?? ""));
  const metric_labels: Record<string, string> = {};
  if (labelSets.length) {
    for (const [k, v] of Object.entries(labelSets[0]!)) {
      if (labelSets.every((set) => set[k] === v)) {
        metric_labels[k] = v;
      }
    }
  }
  const split = [...new Set(panels.flatMap((p) => [p.params.split, p.params.key]).filter((k): k is string => Boolean(k) && k !== "none"))].sort();
  const narrow = [...new Set(panels.flatMap((p) => Object.keys(parseMetricLabels(p.params.ml ?? ""))).filter((k) => !(k in metric_labels)))].sort();
  return { metric_names: names, metric_labels, logs: panels.some(isLogPanel) ? logs : null, split, narrow };
}

function nameCovered(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

/** What a given scope leaves out of the panels: empty when it covers them all. */
export function scopeGaps(scope: ShareScope, panels: SharePanel[]): string[] {
  const gaps: string[] = [];
  for (const p of panels) {
    const m = metricOf(p);
    if (m && !nameCovered(m, scope.metric_names)) {
      gaps.push(`panel ${p.name} reads ${m}, outside metric_names`);
    }
    if (!m && !scope.logs) {
      gaps.push(`panel ${p.name} reads logs, and the scope reads none`);
    }
    for (const k of [p.params.split, p.params.key]) {
      if (k && k !== "none" && !scope.split.includes(k)) {
        gaps.push(`panel ${p.name} splits by ${k}, outside split`);
      }
    }
  }
  return gaps;
}

/** The params a read made with `panel=` uses: the panel's, with only the window left to the page. */
export const pagePanelOverrides = ["range", "from", "to", "step"] as const;

export function panelReadParams(panel: SharePanel, query: (k: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = { ...panel.params };
  if (out.metric && out.reading && !out.metric.includes(":")) {
    out.metric = `${out.reading}:${out.metric}`;
  }
  for (const k of pagePanelOverrides) {
    const v = query(k);
    if (v) {
      out[k] = v;
    }
  }
  return out;
}

/** With raw params off, a read may name a panel and a window, and nothing else. */
export function rawParamsUsed(query: Record<string, string>): string[] {
  return Object.keys(query).filter((k) => k !== "panel" && !(pagePanelOverrides as readonly string[]).includes(k));
}
