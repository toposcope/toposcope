import { type ReactNode } from "react";
import { extraSelectClass } from "@/components/extra-panel";
import { formatAggStat, scaleCount } from "@/fill-histogram";
import { seriesColor, seriesKeys, seriesValue } from "@/histogram-series";
import { cn } from "@/lib/utils";
import type { HistogramBucket, SearchAggResult } from "@/types";
import { alignAggBuckets, finiteAggPeak } from "../../query/agg";
import {
  histogramSplits,
  type HistogramSplit,
} from "../../query/histogram";
import {
  aggFromOpSelect,
  applySeriesSelect,
  numericPickerOps,
  parseNumericPickerOp,
  pickerMetricNames,
  pickerNumericKeys,
  seriesPickFromWidget,
  seriesSelectValue,
} from "../agg-picker";

const LINE = "#a78bfa";

type Props = {
  buckets: HistogramBucket[];
  split: HistogramSplit;
  agg: string | null;
  metric: string | null;
  aggResult: SearchAggResult | null;
  numericKeys: string[];
  metricNames: string[];
  loading: boolean;
  onSplit: (next: HistogramSplit) => void;
  onAgg: (next: string | null) => void;
  onSeries: (next: { agg: string | null; metric: string | null }) => void;
  updated?: ReactNode;
};

export function TimeseriesSpark({
  buckets,
  split,
  agg,
  metric,
  aggResult,
  numericKeys,
  metricNames,
  loading,
  onSplit,
  onAgg,
  onSeries,
  updated = null,
}: Props) {
  const numeric = Boolean(agg || metric);
  const refused = aggResult?.source === "refused";
  const pick = seriesPickFromWidget(agg, metric);
  const seriesKeysList = pickerNumericKeys(numericKeys, agg);
  const metricNamesList = pickerMetricNames(metricNames, metric);
  const keys = seriesKeys(buckets, split);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.n));
  const times = buckets.map((bucket) => bucket.t);
  const lineVals =
    numeric && aggResult && !refused
      ? alignAggBuckets(times, aggResult.buckets)
      : [];
  const linePeak = finiteAggPeak(lineVals);
  const linePts = lineVals
    .map((v, i) => {
      if (v === null) {
        return null;
      }
      const x = ((i + 0.5) / Math.max(1, lineVals.length)) * 200;
      const y = 60 - scaleCount(v, linePeak, false) * 58;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter((pt): pt is string => pt !== null)
    .join(" ");
  const finiteVals = lineVals.filter((v): v is number => v !== null);
  const peakLabel =
    finiteVals.length > 0 ? `peak ${formatAggStat(Math.max(...finiteVals))}` : "";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2">
        {loading && buckets.length === 0 ? (
          <div className="h-full animate-pulse rounded bg-muted/40" />
        ) : numeric ? (
          <div className="relative min-h-0 flex-1">
            {refused ? (
              <span className="font-mono text-[10.5px] text-amber-400">
                {aggResult?.reason}
              </span>
            ) : (
              <>
                <svg
                  viewBox="0 0 200 60"
                  preserveAspectRatio="none"
                  className="absolute inset-0 block h-full w-full"
                >
                  <polyline
                    points={linePts}
                    fill="none"
                    stroke={LINE}
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.95"
                  />
                </svg>
                <span className="absolute top-0 left-0 font-mono text-[10.5px] text-muted-foreground">
                  {peakLabel}
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 items-end gap-px">
              {buckets.map((bucket) => (
                <div
                  key={bucket.t}
                  className="flex h-full min-w-0 flex-1 flex-col-reverse"
                >
                  {keys.map((key, si) => {
                    const n = seriesValue(bucket, key, split);
                    if (n <= 0) {
                      return null;
                    }
                    const frac = bucket.n > 0 ? n / bucket.n : 0;
                    return (
                      <div
                        key={key}
                        className="w-full"
                        style={{
                          height: `${Math.max(1.5, (bucket.n / peak) * 100) * frac}%`,
                          background: seriesColor(key, split, si),
                          borderRadius:
                            si === 0 ? "1px 1px 0 0" : undefined,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {keys.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
                {keys.slice(0, 6).map((key, i) => (
                  <span key={key} className="flex items-center gap-1">
                    <span
                      className="size-1.5 rounded-[2px]"
                      style={{ background: seriesColor(key, split, i) }}
                    />
                    {key}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <select
          className={cn(extraSelectClass, "flex-1")}
          value={split}
          aria-label="Group by"
          onChange={(e) => onSplit(e.target.value as HistogramSplit)}
        >
          {histogramSplits.map((key) => (
            <option key={key} value={key}>
              {key === "none" ? "None" : key[0]!.toUpperCase() + key.slice(1)}
            </option>
          ))}
        </select>
        <select
          className={cn(extraSelectClass, "flex-1")}
          value={seriesSelectValue(pick)}
          aria-label="Series"
          onChange={(e) => onSeries(applySeriesSelect(e.target.value, pick))}
        >
          <option value="">Count</option>
          <option value="rate">Rate</option>
          {seriesKeysList.map((key) => (
            <option key={key} value={`k:${key}`}>
              {key}
            </option>
          ))}
          {metricNamesList.map((name) => (
            <option key={`m:${name}`} value={`m:${name}`}>
              {name}
            </option>
          ))}
        </select>
        {pick.kind === "key" ? (
          <select
            className={cn(extraSelectClass, "w-[62px] shrink-0")}
            value={pick.op}
            aria-label="Reducer"
            onChange={(e) => {
              const op = parseNumericPickerOp(e.target.value);
              if (!op) {
                return;
              }
              const next = aggFromOpSelect(op, pick);
              if (next) {
                onAgg(next);
              }
            }}
          >
            {numericPickerOps.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        ) : null}
        {updated}
      </div>
    </>
  );
}
