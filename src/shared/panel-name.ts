import { activeEquals, compileQuery } from "../query/compile";
import { parseSearchAgg } from "../query/agg";
import { defaultPanelName, maxPanelName, panelWhat, type BoardPanel } from "./boards";

/**
 * Panels named from their query (sheet 50, 50e). Panels made before it carry the generic name
 * they got when they had none (`Volume`, `rate`, `Top values`), so three Number panels on one
 * board all read `rate`. A panel whose name is one of those is shown with a name made from its
 * query: `incus rate`, `agental volume`, `All logs`. The stored name is left as it is.
 */

/** A query longer than this names nothing; its panel keeps the name it has. */
const maxQuerySubject = 24;

type NamedPanel = Pick<BoardPanel, "name" | "q" | "view" | "widget">;

/** The names a panel of this view gets when it has none, or that the sheet's Show calls it. */
function genericNames(panel: Pick<BoardPanel, "view" | "widget">): string[] {
  const what = panelWhat(panel.view, panel.widget);
  switch (panel.view) {
    case "histogram":
      return ["Volume", "Metric", "count", what];
    case "stat":
      return ["Number", "count", "Count", "rate", what];
    case "top":
      return ["Top values", what];
    case "events":
      return ["Events"];
    default:
      return [];
  }
}

/** True when the panel's stored name says only what kind of panel it is. */
export function isGenericPanelName(panel: NamedPanel): boolean {
  if (panel.widget.title && panel.widget.title === panel.name) {
    return false;
  }
  const name = panel.name.trim();
  return name === defaultPanelName(panel.view, panel.widget) || genericNames(panel).includes(name);
}

/**
 * Who the query reads: its service and level values, `incus warn`. A query without them is its
 * own words when short (`status:500`); `""` for every row; null for a query that names nothing
 * short or does not compile.
 */
export function querySubject(q: string): string | null {
  const text = q.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const compiled = compileQuery(text);
  if (compiled.faults.length > 0) {
    return null;
  }
  const equals = activeEquals(compiled);
  const parts = [equals.service, equals.level].filter((list): list is string[] => Boolean(list?.length)).map((list) => list.join("/"));
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return text.length <= maxQuerySubject ? text : null;
}

/** A field's name in words (`agental.call.duration` → `call time`, `duration_ms` → `duration`). */
export function fieldWords(key: string): { words: string; time: boolean } {
  let parts = key.split(".").filter(Boolean);
  if (parts.length > 2) {
    // The first part names who sent it (`agental`), which the query already says.
    parts = parts.slice(1);
  }
  let words = parts.join(" ").replace(/_/g, " ");
  words = words.replace(/ (ms|us|ns|s|sec|secs|seconds|millis)$/, "");
  const time = /(^| )(duration|latency|elapsed|time)$/.test(words);
  if (time && words.includes(" ")) {
    words = words.replace(/ (duration|elapsed)$/, " time");
  }
  return { words, time };
}

/**
 * What a measure reads, short: `count`, `rate`, `call time` for `sum:agental.call.duration`,
 * `p99 call time`, `sum bytes`.
 */
export function measureWords(agg: string | null | undefined): string {
  if (!agg || agg === "count") {
    return "count";
  }
  try {
    const parsed = parseSearchAgg(agg);
    if (!parsed) {
      return "count";
    }
    if (parsed.op === "rate") {
      return "rate";
    }
    const { words, time } = fieldWords(parsed.key);
    // A sum of durations is the time spent: `call time`.
    return parsed.op === "sum" && time && words.includes(" ") ? words : `${parsed.op} ${words}`;
  } catch {
    return agg;
  }
}

/** The name made from a panel's query and view; null when the query names nothing to call it. */
export function derivedPanelName(panel: Pick<BoardPanel, "q" | "view" | "widget">): string | null {
  const subject = querySubject(panel.q);
  if (subject === null) {
    return null;
  }
  const w = panel.widget;
  const join = (what: string) => (subject ? `${subject} ${what}` : `All logs ${what}`);
  switch (panel.view) {
    case "histogram":
      if (w.metric) {
        return subject ? `${subject} ${w.metric}` : w.metric;
      }
      if (w.agg && w.agg !== "count") {
        return join(measureWords(w.agg));
      }
      return subject ? `${subject} volume` : "All logs";
    case "stat":
      return w.metric ? (subject ? `${subject} ${w.metric}` : w.metric) : join(measureWords(w.agg));
    case "top": {
      const field = w.attr ?? (w.split === "none" ? "service" : w.split);
      return subject ? `${subject} top ${field}` : `Top ${field}`;
    }
    case "events":
      return subject ? `${subject} events` : null;
    default:
      return null;
  }
}

/** The name a board panel is shown with: its own, or one made from its query when its own is generic. */
export function panelDisplayName(panel: NamedPanel): string {
  if (!isGenericPanelName(panel)) {
    return panel.name;
  }
  const derived = derivedPanelName(panel);
  return derived ? derived.slice(0, maxPanelName).trimEnd() : panel.name;
}
