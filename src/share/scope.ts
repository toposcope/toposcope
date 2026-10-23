import { compileQuery } from "../query/compile";
import { formatMetricLabels, isMetricIdent, maxMetricLabels, parseMetricLabels } from "../shared/metric";

/**
 * What a share can ever read (#225). Toposcope adds it to every read made with the share; the
 * caller never states it and cannot widen it.
 */
export type ShareScope = {
  /** Metric names the share may read: exact, or a prefix glob (`fleet_*`). Empty: no metrics. */
  metric_names: string[];
  /** Label matchers ANDed onto every metric read (`service:agental`). */
  metric_labels: Record<string, string>;
  /** A `q` ANDed onto every log read, or null: the share reads no logs. */
  logs: string | null;
  /** Keys a read may split or Top-N by: their values are shown. */
  split: string[];
  /** Keys a caller may narrow by, as `key:value`. */
  narrow: string[];
};

export const maxScopeNames = 50;
export const maxScopeKeys = 8;

type Fail = { error: string };

function namePattern(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw.trim().toLowerCase();
  if (text === "*") {
    return text;
  }
  return isMetricIdent(text.endsWith("*") ? text.slice(0, -1) : text) ? text : null;
}

function keyList(raw: unknown, what: string): string[] | Fail {
  if (raw === undefined || raw === null) {
    return [];
  }
  const items = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : null;
  if (!items) {
    return { error: `${what} is a list of keys` };
  }
  const keys: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      return { error: `${what} is a list of keys` };
    }
    const key = item.trim().toLowerCase();
    if (key === "") {
      continue;
    }
    if (!isMetricIdent(key)) {
      return { error: `${what}: "${item}" is not a key` };
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  if (keys.length > maxScopeKeys) {
    return { error: `${what} holds at most ${maxScopeKeys} keys` };
  }
  return keys;
}

/** A scope from the operator API, checked whole; anything off is an error naming it. */
export function parseShareScope(raw: unknown): ShareScope | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "scope is an object" };
  }
  const rec = raw as Record<string, unknown>;
  const namesRaw = rec.metric_names ?? [];
  const nameItems = typeof namesRaw === "string" ? namesRaw.split(/[\s,]+/).filter(Boolean) : namesRaw;
  if (!Array.isArray(nameItems)) {
    return { error: "metric_names is a list" };
  }
  const metric_names: string[] = [];
  for (const item of nameItems) {
    const pattern = namePattern(item);
    if (!pattern) {
      return { error: `metric_names: "${String(item)}" is not a metric name or a prefix glob` };
    }
    if (!metric_names.includes(pattern)) {
      metric_names.push(pattern);
    }
  }
  if (metric_names.length > maxScopeNames) {
    return { error: `metric_names holds at most ${maxScopeNames} names` };
  }
  const labelsRaw = rec.metric_labels ?? "";
  if (typeof labelsRaw !== "string") {
    return { error: "metric_labels is key:value text, as ml= is" };
  }
  const metric_labels = parseMetricLabels(labelsRaw);
  const labelParts = labelsRaw.split(",").filter((part) => part.trim() !== "");
  if (labelParts.length !== Object.keys(metric_labels).length) {
    return { error: `metric_labels: equality matchers only, at most ${maxMetricLabels}, one per key` };
  }
  let logs: string | null = null;
  if (rec.logs !== undefined && rec.logs !== null) {
    if (typeof rec.logs !== "string") {
      return { error: "logs is a q, or null" };
    }
    const q = rec.logs.trim();
    if (q !== "") {
      const fault = compileQuery(q).faults[0];
      if (fault) {
        return { error: `logs: ${fault.msg}` };
      }
      logs = q;
    }
  }
  if (metric_names.length === 0 && logs === null) {
    return { error: "a share reads metrics, logs or both: give metric_names or logs" };
  }
  const split = keyList(rec.split, "split");
  if ("error" in split) {
    return split;
  }
  const narrow = keyList(rec.narrow, "narrow");
  if ("error" in narrow) {
    return narrow;
  }
  for (const key of narrow) {
    if (key in metric_labels) {
      return { error: `narrow: ${key} is fixed by metric_labels` };
    }
  }
  return { metric_names, metric_labels, logs, split, narrow };
}

/** The scope as the API writes it back: labels in their `ml=` spelling. */
export function formatShareScope(scope: ShareScope): Record<string, unknown> {
  return { ...scope, metric_labels: formatMetricLabels(scope.metric_labels) };
}

/** Whether a metric name (a histogram's own name, not `.count`) is inside the scope. */
export function metricAllowed(scope: ShareScope, name: string): boolean {
  return scope.metric_names.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
}

/**
 * A caller's narrowing, `host:box-1,pool:a`: only `narrow` keys, one value each. Empty or absent
 * is no narrowing.
 */
export function parseNarrowing(scope: ShareScope, raw: string | undefined | null): Record<string, string> | Fail {
  const text = (raw ?? "").trim();
  if (text === "") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const colon = part.indexOf(":");
    const key = colon > 0 ? part.slice(0, colon).trim().toLowerCase() : "";
    const value = colon > 0 ? part.slice(colon + 1).trim() : "";
    if (!key || !value || value.includes('"')) {
      return { error: `"${part.trim()}" is not key:value` };
    }
    if (!scope.narrow.includes(key)) {
      return { error: `this share cannot narrow by ${key}` };
    }
    if (key in out) {
      return { error: `${key} is given twice` };
    }
    out[key] = value;
  }
  return out;
}

/** The scope's labels with the caller's narrowing; a narrowing never replaces a scope label. */
export function metricLabelsFor(scope: ShareScope, narrowing: Record<string, string>): Record<string, string> | Fail {
  const labels = { ...narrowing, ...scope.metric_labels };
  if (Object.keys(labels).length > maxMetricLabels) {
    return { error: `at most ${maxMetricLabels} label matchers in all` };
  }
  return labels;
}

/** The scope's log `q` with the caller's narrowing ANDed on, or null when the share reads no logs. */
export function logQueryFor(scope: ShareScope, narrowing: Record<string, string>): string | null {
  if (scope.logs === null) {
    return null;
  }
  // Quoted, so a narrowing is one exact value: `box*` is not a prefix glob here.
  const tokens = Object.entries(narrowing).map(([key, value]) => `${key}:"${value}"`);
  return tokens.length === 0 ? scope.logs : `(${scope.logs}) ${tokens.join(" ")}`;
}
