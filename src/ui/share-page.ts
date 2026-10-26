import { defaultLayout, widgetTitle, type WidgetLayout } from "../shared/widgets";
import { panelParams, panelRead, type PanelRead } from "./share-from-panel";

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


export type AddableSaved = { id: string; name: string; query: string; range: string | null; agg?: string | null; board?: unknown; widgets?: WidgetLayout | null };
export type AddablePanel = {
  id: string;
  label: string;
  panel: NamedPanel;
  /** The share's logs to send when it has none yet: the hunt's own `q`. */
  logs: string | null;
};

const readKey = (r: PanelRead) => JSON.stringify(r);

/**
 * What "Add a panel…" offers on a share's page (#266, frame 26k): every panel a share can hold on
 * every saved hunt and board, the hunt's own volume chart included (a count of its log rows, as
 * the hunt draws it). A panel that draws several metrics is offered one metric at a time, and a
 * log panel that reads a value is offered as its count and its rate, as Share… offers them.
 * With nothing to offer, `why` says so in a sentence.
 */
export function addablePanels(saved: AddableSaved[], shareLogs: string | null): { options: AddablePanel[]; why: string | null } {
  const options: AddablePanel[] = [];
  for (const s of saved) {
    const layout = s.widgets ?? defaultLayout({ agg: s.agg ?? null });
    const from = `${s.board ? "the board" : "the hunt"} ${s.name}`;
    for (const [i, w] of layout.widgets.entries()) {
      const r = panelRead(w);
      const reads = "reads" in r ? r.reads : [...new Map(r.offers.flatMap((o) => o.reads).map((x) => [readKey(x), x])).values()];
      const volume = i === 0 && !w.metric;
      for (const read of reads) {
        const title = volume && read.kind === "logs" ? s.name : "reads" in r ? widgetTitle(w) || read.title : read.title;
        const params = panelParams(read, s.range ?? "24h");
        const panel: NamedPanel = { name: title, params: { ...params, title }, from };
        const huntQ = s.query.trim();
        // A share counts one set of logs; a log panel from another hunt counts the share's, not its own.
        const other = read.kind !== "metric" && shareLogs !== null && shareLogs.trim() !== huntQ;
        options.push({
          id: `${s.id}:${w.id}:${readKey(read)}`,
          label: `${s.name} · ${panelWords(panel)}${other ? ` · counts this share's logs (${shareLogs})` : ""}`,
          panel,
          logs: read.kind !== "metric" && shareLogs === null ? huntQ || null : null,
        });
      }
    }
  }
  return {
    options,
    why: options.length
      ? null
      : saved.length
        ? "No saved hunt or board has a panel a share can hold."
        : "Nothing to add yet: save a hunt, or use Share… on a panel.",
  };
}
