import { createContext, useContext } from "react";
import { metricAdds, metricHeld, type HeldView, type MetricHeld } from "./held-view";

/** What this instance holds, for the hunt Search is showing (#139); null when nothing is linked. */
export const HeldContext = createContext<HeldView | null>(null);

export function useHeldView(): HeldView | null {
  return useContext(HeldContext);
}

/** A metric reading as the partial pill names it: `p99`, `average`. */
function readingWord(result: { kind?: string; reading?: string }): string {
  if (result.reading && result.reading !== "avg" && result.reading !== "heatmap") {
    return result.reading;
  }
  return result.reading === "heatmap" ? "p99" : "average";
}

type MetricRead = { kind?: string; reading?: string; source?: string } | null | undefined;

/** What a metric panel says while a source is short inside the board's window (#331); null when none is. */
export function metricPanelHeld(held: HeldView | null, result: MetricRead, labels: Record<string, string> | undefined): MetricHeld | null {
  if (!result || result.source !== "metric") {
    return null;
  }
  return metricHeld(held, { labels, adds: metricAdds(result), reading: readingWord(result) });
}

export function useMetricHeld(result: MetricRead, labels: Record<string, string> | undefined): MetricHeld | null {
  return metricPanelHeld(useHeldView(), result, labels);
}
