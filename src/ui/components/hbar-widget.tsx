import { HeadPicker } from "@/components/head-picker";
import { useState, type ReactNode } from "react";
import { downloadWidgetSeries, hbarExport } from "@/export-series";
import { formatSeriesTotal } from "@/fill-histogram";
import { seriesColor } from "@/histogram-series";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { FacetValue } from "@/types";
import {
  histogramSplits,
  type HistogramSplit,
} from "../../query/histogram";
import {
  clampHbarN,
  formatSharePct,
  hbarNPresets,
  hbarRows,
  maxHbarN,
  minHbarN,
  pickerAttrKeys,
} from "../../shared/widgets";
import { extraSelectClass } from "@/components/extra-panel";
import { formatFieldToken } from "../query-tokens";

export type HbarCommand = "filter" | "exclude";

type HeadProps = {
  split: HistogramSplit;
  attr: string | null;
  n: number;
  attrKeys: string[];
  skipAttrKeys?: string[];
  usedFields?: readonly string[];
  onSplit: (next: HistogramSplit) => void;
  onAttr: (next: string | null) => void;
  onN: (next: number) => void;
};

type Props = {
  split: HistogramSplit;
  attr: string | null;
  values: FacetValue[];
  total: number;
  n: number;
  pct: boolean;
  loading: boolean;
  onCommand?: (command: HbarCommand, field: string, value: string) => void;
  updated?: ReactNode;
};

export function HbarHead({
  split,
  attr,
  n,
  attrKeys,
  skipAttrKeys = [],
  usedFields = [],
  onSplit,
  onAttr,
  onN,
}: HeadProps) {
  const [customN, setCustomN] = useState(false);
  const count = clampHbarN(n);
  const field = attr ?? split;
  const fieldKeys = pickerAttrKeys(attrKeys, attr, skipAttrKeys);
  const fieldOpts = [
    ...histogramSplits.map((key) => ({
      value: key,
      label: key === "none" ? "None" : key[0]!.toUpperCase() + key.slice(1),
    })),
    ...fieldKeys.map((key) => ({ value: key, label: key })),
  ];
  const fieldLabel = fieldOpts.find((item) => item.value === field)?.label ?? field;
  const nOpts = [
    ...(hbarNPresets as readonly number[]).includes(count)
      ? []
      : [{ value: String(count), label: `Top ${count}` }],
    ...hbarNPresets.map((item) => ({ value: String(item), label: `Top ${item}` })),
    { value: "custom", label: "Custom…" },
  ];

  function commitN(raw: string) {
    onN(clampHbarN(Number(raw)));
    setCustomN(false);
  }

  return (
    <div className="flex min-w-0 max-w-full items-center gap-0.5 overflow-hidden">
      {customN ? (
        <input
          type="number"
          min={minHbarN}
          max={maxHbarN}
          defaultValue={count}
          autoFocus
          aria-label="Custom N"
          title={`1–${maxHbarN}`}
          className={cn(extraSelectClass, "h-[19px] w-12 tabular-nums")}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitN(e.currentTarget.value);
            }
            if (e.key === "Escape") {
              setCustomN(false);
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.isConnected) {
              return;
            }
            commitN(e.currentTarget.value);
          }}
        />
      ) : (
        <HeadPicker
          kind="function"
          label={`Top ${count}`}
          title="How many values to rank"
          value={String(count)}
          items={nOpts}
          onChange={(next) => {
            if (next === "custom") {
              setCustomN(true);
              return;
            }
            commitN(next);
          }}
        />
      )}
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
        ·
      </span>
      <HeadPicker
        kind="value"
        label={fieldLabel}
        title="Field to rank by"
        value={field}
        items={fieldOpts}
        used={usedFields}
        onChange={(next) => {
          if ((histogramSplits as readonly string[]).includes(next)) {
            onSplit(next as HistogramSplit);
            return;
          }
          onAttr(next);
        }}
      />
    </div>
  );
}

export function HbarWidget({
  split,
  attr,
  values,
  total,
  n,
  pct,
  loading,
  onCommand,
  updated = null,
}: Props) {
  const count = clampHbarN(n);
  const source =
    !attr && split === "none" ? [{ v: "events", n: total }] : values;
  const bars = hbarRows(source, count, total);
  const peak = Math.max(1, ...bars.map((bar) => bar.n));
  const shareTotal = bars.reduce((sum, bar) => sum + bar.n, 0);
  const colorSplit = attr ? "service" : split === "none" ? "level" : split;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-3 py-2">
        {loading && bars.length === 0 ? (
          <div className="h-full animate-pulse rounded bg-muted/40" />
        ) : (
          bars.map((bar, i) => {
            const width = Math.max(2, (bar.n / peak) * 100);
            const field = attr ?? (split === "none" ? null : split);
            const clickable =
              Boolean(onCommand) &&
              field !== null &&
              bar.key !== "events" &&
              bar.key !== "other";
            const token = field ? formatFieldToken(field, bar.key) : bar.key;
            const row = (
              <>
                <span className="max-w-[40%] min-w-14 shrink-0 truncate text-left text-[11.5px] text-muted-foreground">
                  {bar.key}
                </span>
                <div className="h-2 min-w-6 flex-1 rounded-sm bg-white/5">
                  <span
                    className="block h-2 rounded-sm"
                    style={{
                      width: `${width}%`,
                      background: seriesColor(bar.key, colorSplit, i),
                    }}
                  />
                </div>
                <span className="min-w-11 shrink-0 text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
                  {formatSeriesTotal(bar.n)}
                </span>
                {pct ? (
                  <span className="w-[34px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground/55 tabular-nums">
                    {formatSharePct(bar.n, shareTotal)}
                  </span>
                ) : null}
              </>
            );
            const rowClass = cn(
              "flex w-full items-center gap-2 rounded-[3.4px] px-1 py-[3px] text-left",
              clickable
                ? "cursor-pointer hover:bg-white/[0.04]"
                : "cursor-default",
            );
            if (!clickable || !field) {
              return (
                <div key={bar.key} className={rowClass}>
                  {row}
                </div>
              );
            }
            return (
              <Popover key={bar.key}>
                <PopoverTrigger asChild>
                  <button type="button" className={rowClass}>
                    {row}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  side="right"
                  sideOffset={8}
                  collisionPadding={8}
                  className="w-[212px] bg-[#18181b] p-1"
                >
                  <PopoverClose asChild>
                    <button
                      type="button"
                      className="flex h-[26px] w-full items-center rounded-[3.4px] px-[7px] text-left text-[12.5px] hover:bg-accent"
                      onClick={() => onCommand?.("filter", field, bar.key)}
                    >
                      Filter{" "}
                      <span className="ml-1 font-mono text-foreground">{token}</span>
                    </button>
                  </PopoverClose>
                  <PopoverClose asChild>
                    <button
                      type="button"
                      className="flex h-[26px] w-full items-center rounded-[3.4px] px-[7px] text-left text-[12.5px] hover:bg-accent"
                      onClick={() => onCommand?.("exclude", field, bar.key)}
                    >
                      Exclude{" "}
                      <span className="ml-1 font-mono text-foreground">
                        -{token}
                      </span>
                    </button>
                  </PopoverClose>
                </PopoverContent>
              </Popover>
            );
          })
        )}
      </div>
      {updated ? <div className="px-3 pb-2">{updated}</div> : null}
    </>
  );
}

export function downloadHbarWidget(
  rows: Array<{ key: string; n: number }>,
  format: Parameters<typeof downloadWidgetSeries>[1],
) {
  downloadWidgetSeries(hbarExport(rows), format);
}

export function hbarPaintedRows(
  split: HistogramSplit,
  attr: string | null,
  values: FacetValue[],
  total: number,
  n: number,
) {
  const source =
    !attr && split === "none" ? [{ v: "events", n: total }] : values;
  return hbarRows(source, clampHbarN(n), total);
}
