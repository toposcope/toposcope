import { panelWhat, type BoardPanel } from "../shared/boards";
import type { PanelData, PanelWindow } from "./board-panel-data";

/**
 * The faint words after a board panel's name (49d): its query, the set inputs and its split,
 * `service:incus · by level`. A count says nothing more; with no query, the split alone.
 */
export function panelSubtitle(panel: Pick<BoardPanel, "q" | "view" | "widget">, inputs: string): string {
  const what = panelWhat(panel.view, panel.widget);
  const query = [panel.q.trim(), inputs.trim()].filter(Boolean).join(" ");
  return [query, what === "count" ? "" : what].filter(Boolean).join(" · ");
}

/**
 * A panel that read no events in its window (49d): it says so in its middle and draws no change
 * marks. A metric is read from its own series, so it is never this.
 */
export function panelNoEvents(panel: Pick<BoardPanel, "view" | "widget">, data: PanelData | null): boolean {
  if (!data || data.error || data.refused || data.total > 0 || panel.widget.metric) {
    return false;
  }
  return panel.view === "histogram" || panel.view === "top" || panel.view === "events";
}

/** `the last 24h`, as a panel names the window it read. */
export function windowWords(win: PanelWindow): string {
  return "range" in win ? `the last ${win.range}` : "this window";
}

/** Under a Number panel's value (49d): `in the last 24h`, or `no events in the last 24h`. */
export function statWords(total: number, win: PanelWindow): string {
  return total > 0 ? `in ${windowWords(win)}` : `no events in ${windowWords(win)}`;
}
