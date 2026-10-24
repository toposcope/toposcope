import { useHeldView } from "../held-context";
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
  hbarRowIsValue,
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
  /** Bars, or a donut of the same rows (#239). */
  view?: "bars" | "donut";
};

/** A donut's ring: its radius in a 200×200 box, and how far round it goes. */
const ringR = 60;
const ringC = 2 * Math.PI * ringR;

/**
 * The donut's slices (#239, 25i): one per row, `other` last and grey, each a dash of the ring in
 * proportion to its count, starting at the top.
 */
export function donutSlices(
  rows: ReadonlyArray<{ key: string; n: number }>,
  color: (key: string, i: number) => string,
): Array<{ key: string; n: number; share: number; dash: string; offset: number; color: string }> {
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  if (total <= 0) {
    return [];
  }
  let at = 0;
  return rows.map((row, i) => {
    const len = (row.n / total) * ringC;
    // A hairline gap between slices, so neighbours of one colour still read as two.
    const slice = {
      key: row.key,
      n: row.n,
      share: row.n / total,
      dash: `${Math.max(0, len - 1.5).toFixed(2)} ${(ringC - Math.max(0, len - 1.5)).toFixed(2)}`,
      offset: -at,
      color: hbarRowIsValue(row.key) ? color(row.key, i) : "#94a3b8",
    };
    at += len;
    return slice;
  });
}

function Donut({
  bars,
  colorFor,
  floors,
  rowFor,
}: {
  bars: Array<{ key: string; n: number }>;
  colorFor: (key: string, i: number) => string;
  floors: boolean[];
  rowFor: (bar: { key: string; n: number }, i: number, inner: ReactNode) => ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = donutSlices(bars, colorFor);
  const total = bars.reduce((sum, bar) => sum + bar.n, 0);
  const hovered = hover === null ? null : slices[hover];
  return (
    <div className="flex min-h-0 flex-1 items-center gap-4 px-3 py-2">
      <div className="relative aspect-square h-full max-h-[200px] min-h-[96px] shrink-0">
        <svg viewBox="0 0 200 200" className="block h-full w-full" role="img" aria-label="Share of the window, top values and other">
          <g transform="rotate(-90 100 100)" fill="none" strokeWidth={30}>
            {slices.map((slice, i) => (
              <circle
                key={slice.key}
                cx={100}
                cy={100}
                r={ringR}
                stroke={slice.color}
                strokeDasharray={slice.dash}
                strokeDashoffset={slice.offset}
                strokeWidth={hover === i ? 36 : 30}
                strokeOpacity={hover === null || hover === i ? 1 : 0.35}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[18px] font-semibold tabular-nums">
            {hovered ? formatSharePct(hovered.n, total) : formatSeriesTotal(total)}
          </span>
          <span className="max-w-[70%] truncate text-[10.5px] text-muted-foreground">{hovered ? hovered.key : "in the window"}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-auto">
        {bars.map((bar, i) =>
          rowFor(
            bar,
            i,
            <>
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: slices[i]?.color }} />
              <span className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-muted-foreground">{bar.key}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80 tabular-nums">{formatSharePct(bar.n, total)}</span>
              <span className="min-w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                {floors[i] ? "≥" : ""}
                {formatSeriesTotal(bar.n)}
              </span>
            </>,
          ),
        )}
      </div>
    </div>
  );
}

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
  view = "bars",
}: Props) {
  const count = clampHbarN(n);
  const source =
    !attr && split === "none" ? [{ v: "events", n: total }] : values;
  const bars = hbarRows(source, count, total);
  const peak = Math.max(1, ...bars.map((bar) => bar.n));
  const shareTotal = bars.reduce((sum, bar) => sum + bar.n, 0);
  const colorSplit = attr ? "service" : split === "none" ? "level" : split;
  const held = useHeldView();
  const barField = attr ?? (split === "none" ? null : split);
  // #139: every bar a short source could feed is a floor; the order may be wrong, so the panel
  // says once that it ranks what is here.
  const floors = held?.floor
    ? bars.map((bar) => (barField && hbarRowIsValue(bar.key) ? held.facetFloor(barField, bar.key) : true))
    : bars.map(() => false);
  const floored = floors.filter(Boolean).length;
  const heldNote =
    held?.pill && floored > 0
      ? floored === bars.length
        ? `${held.pill} — ranks are of what is here`
        : floored === 1
          ? `${held.pill} — ${formatFieldToken(barField ?? "", bars[floors.indexOf(true)]!.key)} is a floor`
          : `${held.pill} — ${floored} bars are floors`
      : null;

  const field = attr ?? (split === "none" ? null : split);
  /** A row, clickable for Filter / Exclude when it is a real value: a bar, or a donut's legend line. */
  function rowFor(bar: { key: string; n: number }, _i: number, inner: ReactNode) {
    const clickable = Boolean(onCommand) && field !== null && hbarRowIsValue(bar.key);
    const token = field ? formatFieldToken(field, bar.key) : bar.key;
    const rowClass = cn(
      "flex w-full items-center gap-2 rounded-[3.4px] px-1 py-[3px] text-left",
      clickable ? "cursor-pointer hover:bg-[var(--plot-hover)]" : "cursor-default",
    );
    if (!clickable || !field) {
      return (
        <div key={bar.key} className={rowClass}>
          {inner}
        </div>
      );
    }
    return (
      <Popover key={bar.key}>
        <PopoverTrigger asChild>
          <button type="button" className={rowClass}>
            {inner}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="right" sideOffset={8} collisionPadding={8} className="w-[212px] bg-[var(--plot-pop)] p-1">
          <PopoverClose asChild>
            <button
              type="button"
              className="flex h-[26px] w-full items-center rounded-[3.4px] px-[7px] text-left text-[12.5px] hover:bg-accent"
              onClick={() => onCommand?.("filter", field, bar.key)}
            >
              Filter <span className="ml-1 font-mono text-foreground">{token}</span>
            </button>
          </PopoverClose>
          <PopoverClose asChild>
            <button
              type="button"
              className="flex h-[26px] w-full items-center rounded-[3.4px] px-[7px] text-left text-[12.5px] hover:bg-accent"
              onClick={() => onCommand?.("exclude", field, bar.key)}
            >
              Exclude <span className="ml-1 font-mono text-foreground">-{token}</span>
            </button>
          </PopoverClose>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      {view === "donut" && !(loading && bars.length === 0) ? (
        <Donut bars={bars} colorFor={(key, i) => seriesColor(key, colorSplit, i)} floors={floors} rowFor={rowFor} />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-3 py-2">
        {loading && bars.length === 0 ? (
          <div className="h-full animate-pulse rounded bg-muted/40" />
        ) : (
          bars.map((bar, i) => {
            const width = Math.max(2, (bar.n / peak) * 100);
            return rowFor(
              bar,
              i,
              <>
                <span className="max-w-[40%] min-w-14 shrink-0 truncate text-left text-[11.5px] text-muted-foreground">
                  {bar.key}
                </span>
                <div className="h-2 min-w-6 flex-1 rounded-sm bg-[var(--plot-track)]">
                  <span
                    className="block h-2 rounded-sm"
                    style={{
                      width: `${width}%`,
                      background: seriesColor(bar.key, colorSplit, i),
                    }}
                  />
                </div>
                <span className="min-w-11 shrink-0 text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
                  {floors[i] ? "≥" : ""}
                  {formatSeriesTotal(bar.n)}
                </span>
                {pct ? (
                  <span className="w-[34px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground/55 tabular-nums">
                    {formatSharePct(bar.n, shareTotal)}
                  </span>
                ) : null}
              </>,
            );
          })
        )}
      </div>
      )}
      {heldNote ? (
        <div className="truncate px-3 pb-1 text-[10.5px] text-amber-400">▲ {heldNote}</div>
      ) : null}
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

/** Bars · Donut in a Top-N panel's head (#239, 25h). */
export function TopViewPicker({ value, onChange }: { value: "bars" | "donut"; onChange: (next: "bars" | "donut") => void }) {
  return (
    <div role="group" aria-label="View" className="flex shrink-0 overflow-hidden rounded-[4.4px] border border-input" onPointerDown={(e) => e.stopPropagation()}>
      {(["bars", "donut"] as const).map((id, i) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          className={`h-[22px] px-2 text-[11.5px] ${i > 0 ? "border-l border-input" : ""} ${
            value === id ? "bg-plate/15 text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onChange(id)}
        >
          {id === "bars" ? "Bars" : "Donut"}
        </button>
      ))}
    </div>
  );
}
