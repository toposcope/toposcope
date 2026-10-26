/** Pure pieces of a share's page (#266, frame 26k). */

export type NamedPanel = { name: string; params: Record<string, string>; from?: string };

/** "p99 fleet_latency · by host · 24h · line": what a named panel draws, in words. */
export function panelWords(p: NamedPanel): string {
  const q = p.params;
  const chart = q.chart ?? "line";
  if (chart === "top" || chart === "donut") {
    return [`top ${q.n ?? "10"} ${q.key ?? ""} by rows`, q.range, chart].filter(Boolean).join(" · ");
  }
  const what = q.metric
    ? (q.metric.includes(":") ? `${q.metric.split(":")[0]} ${q.metric.split(":").slice(1).join(":")}` : q.reading ? `${q.reading} ${q.metric}` : q.metric)
    : `${q.agg ?? "count"} of logs`;
  const split = q.split && q.split !== "none" ? `by ${q.split}` : null;
  return [what, split, q.range, chart].filter(Boolean).join(" · ");
}

/** The fence's lines, as the page shows them (26k): metrics, labels, logs, may split by, limits, framed by. */
export function fenceLines(share: {
  scope: { metric_names: string[]; metric_labels: string; logs: string | null; split: string[] };
  limits: { min_step: string; max_range: string; max_lookback: string; reads_per_minute: number };
  embed: { frame_ancestors: string[] };
}): Array<[string, string]> {
  return [
    ["metrics", share.scope.metric_names.length ? share.scope.metric_names.join(" · ") : "none"],
    ["labels", share.scope.metric_labels || "any"],
    ["logs", share.scope.logs ?? "none"],
    ["may split by", share.scope.split.length ? share.scope.split.join(" · ") : "nothing"],
    ["limits", `${share.limits.min_step} bars · ${share.limits.max_range} window · ${share.limits.max_lookback} back · ${share.limits.reads_per_minute} reads/min`],
    ["framed by", share.embed.frame_ancestors.length ? share.embed.frame_ancestors.join(" · ") : "nobody: JSON only"],
  ];
}
