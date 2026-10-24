/**
 * Share from a panel (#236, frames 24a–24h): the scope proposed from what panels read, how it
 * merges into an existing share, and each panel's tag. Pure, so the dialog is a thin paint.
 */
import type { WidgetDef } from "../shared/widgets";
import { formatRangeToken, partsFromMs } from "../query/relative";
import type { ShareView } from "./share-cover";

/** What one panel reads, for sharing it. */
export type PanelRead =
  | {
      kind: "metric";
      /** The name without its reading: `http.server.duration`. */
      name: string;
      /** As the panel reads it: `p99:http.server.duration`. */
      ref: string;
      labels: Record<string, string>;
      split: string | null;
      chart: "line" | "bars" | "stacked" | "stat";
      title: string;
    }
  | { kind: "logs"; agg: "count" | "rate"; split: "level" | "service" | "host" | null; chart: "line" | "stat"; title: string }
  | { kind: "top"; key: string; n: number; donut: boolean; title: string };

/** Why a panel cannot be shared as it is (24f), and what can be instead. */
export type PanelRefusal = {
  why: string;
  /** Each offer is a way it can be shared: a label for its button, and what it reads then. */
  offers: Array<{ label: string; reads: PanelRead[] }>;
};

const nameOf = (ref: string) => ref.replace(/^(count|sum|avg|p50|p90|p99|heatmap):/, "");

function titleOf(widget: WidgetDef, fallback: string): string {
  return widget.title?.trim() || fallback;
}

/** What a panel reads, or why it cannot be shared as it is and what can be (24f). */
export function panelRead(widget: WidgetDef): { reads: PanelRead[] } | PanelRefusal {
  if (widget.kind === "hbar") {
    const key = widget.attr ?? (widget.split === "none" ? null : widget.split);
    if (!key) {
      return { why: "This Top-N counts every row as one: there is no key to count by.", offers: [] };
    }
    return { reads: [{ kind: "top", key, n: widget.n, donut: widget.topView === "donut", title: titleOf(widget, `top ${widget.n} by ${key}`) }] };
  }
  if (widget.metric) {
    const own: PanelRead = {
      kind: "metric",
      name: nameOf(widget.metric),
      ref: widget.metric,
      labels: widget.metricLabels,
      split: widget.metricSplit ?? null,
      chart: widget.kind === "stat" ? "stat" : (widget.metricChart ?? "line"),
      title: titleOf(widget, nameOf(widget.metric)),
    };
    const lines = widget.kind === "timeseries" ? (widget.lines ?? []) : [];
    if (lines.length > 0) {
      const each: PanelRead[] = [
        own,
        ...lines.map((line) => ({
          kind: "metric" as const,
          name: nameOf(line.metric),
          ref: line.metric,
          labels: line.labels,
          split: null,
          chart: "line" as const,
          title: nameOf(line.metric),
        })),
      ];
      return {
        why: `This panel draws ${each.length} metrics on one axis (${each.map((r) => (r as { name: string }).name).join(" · ")}). An embed draws one.`,
        offers: [
          { label: `Share ${own.name} alone`, reads: [own] },
          { label: "One panel each", reads: each },
        ],
      };
    }
    return { reads: [own] };
  }
  const agg = widget.agg ?? "count";
  const chart = widget.kind === "stat" ? "stat" : "line";
  const split = widget.kind === "timeseries" && widget.split !== "none" ? widget.split : null;
  if (agg === "count" || agg === "rate") {
    return { reads: [{ kind: "logs", agg, split, chart, title: titleOf(widget, agg === "rate" ? "log lines / s" : "log lines") }] };
  }
  const as = (a: "count" | "rate"): PanelRead => ({ kind: "logs", agg: a, split, chart, title: titleOf(widget, a === "rate" ? "log lines / s" : "log lines") });
  return {
    why: `It reads ${agg} from log lines. Through a share, log lines are counted, never read for a value: a slow request's own number could be an id.`,
    offers: [
      { label: "Share it as a count", reads: [as("count")] },
      { label: "Share it as a rate", reads: [as("rate")] },
    ],
  };
}

/** A prefix glob for the metrics like this one (`fleet_cpu_seconds` → `fleet_*`), or null when the name has no stem. */
export function likePattern(name: string): string | null {
  const at = [name.indexOf("_"), name.indexOf(".")].filter((i) => i > 0);
  if (at.length === 0) {
    return null;
  }
  return `${name.slice(0, Math.min(...at) + 1)}*`;
}

export type ProposalChoices = {
  /** Only the panels' metrics, or every metric like them. */
  allLike: boolean;
  /** Show one line per split value (the split key becomes a split key of the share). */
  splitOn: boolean;
  /** Let a panel pick one value of the split key. */
  narrowOn: boolean;
  /** Also count the service's log lines. */
  logsOn: boolean;
};

export type ProposedScope = {
  metric_names: string[];
  metric_labels: string;
  logs: string | null;
  split: string[];
  narrow: string[];
};

/**
 * The scope proposed from what the panels read (24b): their metrics (or all like them), their
 * shared labels fixed, their split keys, and the hunt's `q` for log panels. Labels two metric panels
 * disagree on cannot both be fixed: such a label is left out, and the dialog says so.
 */
export function proposeScope(reads: PanelRead[], query: string, choices: ProposalChoices): { scope: ProposedScope; dropped: string[] } {
  const metrics = reads.filter((r): r is Extract<PanelRead, { kind: "metric" }> => r.kind === "metric");
  const names = [...new Set(metrics.map((m) => (choices.allLike ? (likePattern(m.name) ?? m.name) : m.name)))];
  const labels: Record<string, string> = {};
  const dropped: string[] = [];
  metrics.forEach((m, i) => {
    for (const [k, v] of Object.entries(m.labels)) {
      if (i === 0) labels[k] = v;
    }
    if (i > 0) {
      for (const k of Object.keys(labels)) {
        if (m.labels[k] !== labels[k]) {
          dropped.push(k);
          delete labels[k];
        }
      }
    }
  });
  const splitKeys = [
    ...new Set(
      reads.flatMap((r) => (r.kind === "metric" ? (r.split ? [r.split] : []) : r.kind === "logs" ? (r.split ? [r.split] : []) : [r.key])),
    ),
  ];
  const service = labels.service;
  const logReads = reads.some((r) => r.kind !== "metric");
  const logs = logReads ? query.trim() || (service ? `service:${service}` : null) : choices.logsOn && service ? `service:${service}` : null;
  return {
    scope: {
      metric_names: names,
      metric_labels: Object.entries(labels)
        .map(([k, v]) => `${k}:${v}`)
        .join(","),
      logs,
      split: choices.splitOn || reads.some((r) => r.kind === "top") ? splitKeys : [],
      narrow: choices.narrowOn ? splitKeys.filter((k) => !(k in labels)) : [],
    },
    dropped: [...new Set(dropped)],
  };
}

/**
 * The proposed scope added to an existing share (24e): its names, split and narrow keys grow; its
 * fixed labels and log `q` must agree, or it cannot take the panel and says why.
 */
export function mergeScope(share: ShareView, add: ProposedScope): { scope: ProposedScope; added: string[] } | { why: string } {
  if (add.metric_labels && share.scope.metric_labels && add.metric_labels !== share.scope.metric_labels) {
    return { why: `${share.name} is fixed to ${share.scope.metric_labels}; this panel reads ${add.metric_labels}.` };
  }
  if (add.logs && share.scope.logs && add.logs !== share.scope.logs) {
    return { why: `${share.name} counts the log lines of ${share.scope.logs}; this panel counts ${add.logs}.` };
  }
  const covered = (name: string) =>
    share.scope.metric_names.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
  const added = add.metric_names.filter((n) => !share.scope.metric_names.includes(n) && !covered(n.replace(/\*$/, "")));
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    scope: {
      metric_names: union(share.scope.metric_names, added),
      metric_labels: share.scope.metric_labels || add.metric_labels,
      logs: share.scope.logs ?? add.logs,
      split: union(share.scope.split, add.split),
      narrow: union(share.scope.narrow, add.narrow),
    },
    added: [...added, ...(add.logs && !share.scope.logs ? [`log lines of ${add.logs}`] : [])],
  };
}

/** One panel's embed tag (24d step 3): its params as the embed reads them; `${ticket}` is the backend's. */
export function panelTag(origin: string, read: PanelRead, range: string): string {
  const attrs: Array<[string, string]> = [["ticket", "${ticket}"]];
  if (read.kind === "metric") {
    if (read.chart !== "line") attrs.push(["chart", read.chart]);
    attrs.push(["metric", read.ref]);
    if (read.split) attrs.push(["split", read.split]);
  } else if (read.kind === "logs") {
    if (read.chart !== "line") attrs.push(["chart", read.chart]);
    attrs.push(["agg", read.agg]);
    if (read.split) attrs.push(["split", read.split]);
  } else {
    attrs.push(["chart", read.donut ? "donut" : "top"], ["key", read.key], ["n", String(read.n)]);
  }
  attrs.push(["range", range], ["title", read.title]);
  const quote = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<script src="${origin}/embed.js"\n  ${attrs.map(([k, v]) => `data-${k}="${quote(v)}"`).join("\n  ")}></script>`;
}

/** The query string of a panel's embed, for the dialog's live preview (24d). */
export function panelEmbedQuery(read: PanelRead, range: string, theme: "dark" | "light" = "dark"): URLSearchParams {
  const q = new URLSearchParams();
  if (read.kind === "metric") {
    if (read.chart !== "line") q.set("chart", read.chart);
    q.set("metric", read.ref);
    if (read.split) q.set("split", read.split);
  } else if (read.kind === "logs") {
    if (read.chart !== "line") q.set("chart", read.chart);
    q.set("agg", read.agg);
    if (read.split) q.set("split", read.split);
  } else {
    q.set("chart", read.donut ? "donut" : "top");
    q.set("key", read.key);
    q.set("n", String(read.n));
  }
  q.set("range", range);
  q.set("title", read.title);
  q.set("theme", theme);
  return q;
}

/** A name for a new share, from the service it reads (24c): `agental-console`. */
export function proposedShareName(scope: ProposedScope, taken: readonly string[]): string {
  const service = /(?:^|,)service:([^,]+)/.exec(scope.metric_labels)?.[1] ?? /service:"?([A-Za-z0-9_.-]+)/.exec(scope.logs ?? "")?.[1];
  const base = `${(service ?? "panels").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}-console`.slice(0, 56);
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

/** The panel's window as an embed `range`: the Quick chip it is (`24h`, not `1d`), else its span. */
export function panelRange(spanMs: number): string {
  const quick = (["15m", "1h", "4h", "24h", "7d"] as const).find(
    (t) => ({ "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "24h": 86_400_000, "7d": 604_800_000 })[t] === spanMs,
  );
  if (quick) return quick;
  const { count, unit } = partsFromMs(spanMs);
  return formatRangeToken(count, unit);
}
