import { useHeldView, useMetricHeld } from "../held-context";
import { overWhatIsHereWords } from "../../shared/held-words";
import { type ReactNode } from "react";
import { HeadPicker } from "@/components/head-picker";
import { downloadWidgetSeries, statExport } from "@/export-series";
import { abbrevCount, formatAggStat } from "@/fill-histogram";
import { printUnit, unitsDifferWords } from "../metric-unit";
import type { SearchAggResult } from "@/types";
import { seriesLabel } from "../../query/agg";
import {
  aggFromOpSelect,
  numericPickerOps,
  parseNumericPickerOp,
  seriesPickFromWidget,
} from "../agg-picker";
import { pickedEntry, useSeriesCatalog } from "../series-catalog";
import { formatMetricRef, histogramReadings, parseHistogramReading } from "../../shared/metric";
import { metricView, statWords } from "../series-list";
import { SeriesPicker } from "./series-picker";

const FN = "#a78bfa";

type HeadProps = {
  agg: string | null;
  metric: string | null;
  /** Kept for callers; the Series list reads the window's catalog itself. */
  numericKeys?: string[];
  metricNames?: string[];
  usedSeries?: readonly string[];
  onAgg: (next: string | null) => void;
  onSeries: (next: { agg: string | null; metric: string | null }) => void;
  /** The same metric, read another way: its labels stay. */
  onMetric?: (next: string) => void;
};

type Props = {
  total: number;
  agg: string | null;
  metric: string | null;
  /** The metric's label matchers: a `toposcope` one keeps a Stat to one source's tells (#331). */
  metricLabels?: Record<string, string>;
  aggResult: SearchAggResult | null;
  loading: boolean;
  updated?: ReactNode;
};

/**
 * The one number a metric Stat shows (#331): its own, or when its points came in more than one
 * unit, the line in the unit the name was last sent with. Never a sum across units.
 */
export function metricStat(result: SearchAggResult | null): { stat: number | null; unit: string | undefined } {
  if (!result?.units_differ || !result.splits?.length) {
    return { stat: result?.stat ?? null, unit: result?.unit };
  }
  const line =
    result.splits.find((s) => (s.unit ?? "") === (result.unit ?? "") && (!s.kind || s.kind === result.kind)) ??
    result.splits[result.splits.length - 1]!;
  return { stat: line.stat, unit: line.unit };
}

export function StatHead({
  agg,
  metric,
  onAgg,
  onSeries,
  onMetric,
}: HeadProps) {
  const pick = seriesPickFromWidget(agg === "count" ? null : agg, metric);
  const catalog = useSeriesCatalog();
  const view = pick.kind === "metric" ? metricView(pick, pickedEntry(catalog, pick.name)) : null;
  const named = pick.kind === "key" || pick.kind === "metric";
  return (
    <div className="flex min-w-0 max-w-full items-center gap-0.5 overflow-hidden">
      {pick.kind === "key" ? (
        <HeadPicker
          kind="function"
          label={pick.op}
          title="Function applied to this series"
          value={pick.op}
          items={numericPickerOps.map((op) => ({ value: op, label: op }))}
          onChange={(next) => {
            const op = parseNumericPickerOp(next);
            if (!op) {
              return;
            }
            const expr = aggFromOpSelect(op, pick);
            if (expr) {
              onAgg(expr);
            }
          }}
        />
      ) : null}
      {view?.kind === "histogram" ? (
        // A histogram's reading is a choice, as a log field's function is.
        <HeadPicker
          kind="function"
          label={view.reading ?? "p99"}
          title="How this histogram is read"
          value={view.reading ?? "p99"}
          items={histogramReadings.filter((reading) => reading !== "heatmap").map((reading) => ({ value: reading, label: reading }))}
          onChange={(next) => {
            const reading = parseHistogramReading(next);
            if (reading) {
              onMetric?.(formatMetricRef({ name: view.name, reading }));
            }
          }}
        />
      ) : view ? (
        // A gauge's and a counter's function is not a choice, so it is not dashed.
        <span
          className="shrink-0 cursor-help px-px font-mono text-[11.5px] leading-[1.55] whitespace-nowrap"
          style={{ color: FN }}
          title={
            view.kind === "counter"
              ? "Counter — the sum of what arrived in the window. Not a level."
              : "Gauge — a level. The average of the values sent in the window."
          }
        >
          {view.kind === "counter" ? "sum" : "avg"}
        </span>
      ) : null}
      {named ? <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">(</span> : null}
      <SeriesPicker
        variant="head"
        card
        pick={pick}
        agg={agg === "count" ? null : agg}
        view={view}
        onSeries={onSeries}
      />
      {named ? <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">)</span> : null}
    </div>
  );
}

export function StatWidget({
  total,
  agg,
  metric,
  metricLabels,
  aggResult,
  loading,
  updated = null,
}: Props) {
  const catalog = useSeriesCatalog();
  const held = useHeldView();
  // #331: a sum or a count over a short source is a floor; an average or a percentile is partial.
  const metricShort = useMetricHeld(metric ? aggResult : null, metricLabels);
  const unitsNote = metric ? unitsDifferWords(aggResult?.units_differ) : null;
  const shown = metricStat(aggResult);
  const isCount = !metric && (!agg || agg === "count");
  // #139: a count a short source could feed is a floor; a percentile, rate or average keeps its
  // number and says it is over what is here.
  const heldNote = !metric && held?.floor ? (isCount ? held.pill : overWhatIsHereWords(held.gaps)) : null;
  const label = metric
    ? (aggResult?.expr ?? metric)
    : isCount
      ? "count"
      : agg === "rate"
        ? "rate"
        : agg ?? "count";
  // A metric's one number is named by how it was read: a counter's is a sum, never a level.
  const pick = seriesPickFromWidget(null, metric);
  const view = pick.kind === "metric" ? metricView(pick, pickedEntry(catalog, pick.name), aggResult) : null;
  const quiet = Boolean(metric) && aggResult?.source === "metric" && shown.stat === null;
  const note = view
    ? quiet
      ? `no points ${catalog.window ? `in the last ${catalog.window}` : "in this window"} · ${view.kind}`
      : statWords(view.kind, catalog.window, view.reading)
    : `window ${label}`;
  const value = isCount
    ? `${heldNote ? "≥" : ""}${abbrevCount(total)}`
    : aggResult?.source === "refused"
      ? "—"
      : `${metricShort?.floor && !quiet ? "≥" : ""}${formatAggStat(shown.stat)}`;
  const metricNote = metricShort ? metricShort.pill : null;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-3 pb-3">
        {loading ? (
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        ) : (
          <>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-[34px] leading-none font-medium tracking-[-0.025em] tabular-nums">
                {value}
              </span>
              {agg === "rate" ? (
                <span className="font-mono text-[15px] text-muted-foreground">/s</span>
              ) : metric && !quiet && printUnit(shown.unit) ? (
                // #104: the unit as the app sent it (13h); a histogram's count has none.
                <span className="font-mono text-[15px] text-muted-foreground">{printUnit(shown.unit)}</span>
              ) : null}
            </div>
            <div
              className={`mt-[3px] truncate text-[10.5px] ${
                aggResult?.source === "refused" || quiet || heldNote || metricNote ? "text-amber-400" : "text-muted-foreground"
              }`}
              title={unitsNote ?? undefined}
            >
              {aggResult?.source === "refused"
                ? aggResult.reason
                : heldNote
                  ? `▲ ${heldNote}`
                  : metricNote
                    ? `▲ ${metricNote}`
                    : (unitsNote ?? note)}
              {updated}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function statSeriesFile(
  total: number,
  agg: string | null,
  metric: string | null,
  aggResult: SearchAggResult | null,
) {
  const isCount = !metric && (!agg || agg === "count");
  const exportSeries = isCount
    ? "count"
    : metric
      ? (aggResult?.expr ?? metric)
      : seriesLabel(agg === "count" ? null : agg);
  const exportValue = isCount
    ? total
    : aggResult?.source === "refused"
      ? null
      : metricStat(aggResult).stat;
  return statExport({ series: exportSeries, value: exportValue, total });
}

export function downloadStatWidget(
  total: number,
  agg: string | null,
  metric: string | null,
  aggResult: SearchAggResult | null,
  format: Parameters<typeof downloadWidgetSeries>[1],
) {
  downloadWidgetSeries(statSeriesFile(total, agg, metric, aggResult), format);
}
