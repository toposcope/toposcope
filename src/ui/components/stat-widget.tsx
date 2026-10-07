import { type ReactNode } from "react";
import { HeadPicker } from "@/components/head-picker";
import { downloadWidgetSeries, statExport } from "@/export-series";
import { abbrevCount, formatAggStat } from "@/fill-histogram";
import type { SearchAggResult } from "@/types";
import { seriesLabel } from "../../query/agg";
import {
  aggFromOpSelect,
  numericPickerOps,
  parseNumericPickerOp,
  seriesPickFromWidget,
} from "../agg-picker";
import { pickedEntry, useSeriesCatalog } from "../series-catalog";
import { statWords } from "../series-list";
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
};

type Props = {
  total: number;
  agg: string | null;
  metric: string | null;
  aggResult: SearchAggResult | null;
  loading: boolean;
  updated?: ReactNode;
};

export function StatHead({
  agg,
  metric,
  onAgg,
  onSeries,
}: HeadProps) {
  const pick = seriesPickFromWidget(agg === "count" ? null : agg, metric);
  const catalog = useSeriesCatalog();
  const metricKind = metric ? (pickedEntry(catalog, metric)?.kind ?? "gauge") : undefined;
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
      {pick.kind === "metric" ? (
        // A gauge's and a counter's function is not a choice, so it is not dashed.
        <span
          className="shrink-0 cursor-help px-px font-mono text-[11.5px] leading-[1.55] whitespace-nowrap"
          style={{ color: FN }}
          title={
            metricKind === "counter"
              ? "Counter — the sum of what arrived in the window. Not a level."
              : "Gauge — a level. The average of the values sent in the window."
          }
        >
          {metricKind === "counter" ? "sum" : "avg"}
        </span>
      ) : null}
      {named ? <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">(</span> : null}
      <SeriesPicker
        variant="head"
        card
        pick={pick}
        agg={agg === "count" ? null : agg}
        kind={metricKind}
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
  aggResult,
  loading,
  updated = null,
}: Props) {
  const catalog = useSeriesCatalog();
  const isCount = !metric && (!agg || agg === "count");
  const label = metric
    ? (aggResult?.expr ?? metric)
    : isCount
      ? "count"
      : agg === "rate"
        ? "rate"
        : agg ?? "count";
  // A metric's one number is named by how it was read: a counter's is a sum, never a level.
  const metricKind = metric ? (aggResult?.kind ?? pickedEntry(catalog, metric)?.kind ?? "gauge") : null;
  const quiet = Boolean(metric) && aggResult?.source === "metric" && aggResult.stat === null;
  const note = metricKind
    ? quiet
      ? `no points ${catalog.window ? `in the last ${catalog.window}` : "in this window"} · ${metricKind}`
      : statWords(metricKind, catalog.window)
    : `window ${label}`;
  const value = isCount
    ? abbrevCount(total)
    : aggResult?.source === "refused"
      ? "—"
      : formatAggStat(aggResult?.stat);

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
              ) : null}
            </div>
            <div
              className={`mt-[3px] truncate text-[10.5px] ${
                aggResult?.source === "refused" || quiet ? "text-amber-400" : "text-muted-foreground"
              }`}
            >
              {aggResult?.source === "refused" ? aggResult.reason : note}
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
      : (aggResult?.stat ?? null);
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
