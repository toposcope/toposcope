import { type ReactNode } from "react";
import { HeadPicker } from "@/components/head-picker";
import { downloadWidgetSeries, statExport } from "@/export-series";
import { abbrevCount, formatAggStat } from "@/fill-histogram";
import type { SearchAggResult } from "@/types";
import { seriesLabel } from "../../query/agg";
import {
  aggFromOpSelect,
  applySeriesSelect,
  numericPickerOps,
  parseNumericPickerOp,
  seriesPickFromWidget,
  seriesPickerOptions,
  seriesSelectValue,
} from "../agg-picker";

type HeadProps = {
  agg: string | null;
  metric: string | null;
  numericKeys: string[];
  metricNames: string[];
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
  numericKeys,
  metricNames,
  usedSeries = [],
  onAgg,
  onSeries,
}: HeadProps) {
  const pick = seriesPickFromWidget(agg === "count" ? null : agg, metric);
  const seriesValue = seriesSelectValue(pick);
  const seriesOpts = seriesPickerOptions(numericKeys, metricNames, agg, metric);
  const seriesLabelText =
    seriesOpts.find((item) => item.value === seriesValue)?.label ?? "Count";
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
      <HeadPicker
        kind="value"
        label={seriesLabelText}
        title={pick.kind === "key" ? "Series this function reduces" : "What this panel counts"}
        value={seriesValue}
        items={seriesOpts}
        used={usedSeries}
        pre={pick.kind === "key" ? "(" : undefined}
        post={pick.kind === "key" ? ")" : undefined}
        onChange={(next) => onSeries(applySeriesSelect(next, pick))}
      />
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
  const isCount = !metric && (!agg || agg === "count");
  const label = metric
    ? (aggResult?.expr ?? metric)
    : isCount
      ? "count"
      : agg === "rate"
        ? "rate"
        : agg ?? "count";
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
                aggResult?.source === "refused" ? "text-amber-400" : "text-muted-foreground"
              }`}
            >
              {aggResult?.source === "refused" ? aggResult.reason : `window ${label}`}
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
