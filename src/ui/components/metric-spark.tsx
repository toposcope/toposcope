import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatAggStat } from "@/fill-histogram";
import type { SearchAggResult } from "@/types";
import { alignAggBuckets } from "../../query/agg";
import { useSeriesCatalog } from "../series-catalog";
import { withUnit } from "../metric-unit";

/** One line per value of a split (frames 13e, 13g); the sixth colour is not `other`'s grey. */
export const splitPalette = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#e2e8f0", "#c084fc", "#2dd4bf"];
export const otherColor = "#94a3b8";
const LINE = "#a78bfa";
/** Up to this many lines are named at their ends; more get a legend (13g). */
export const endLabelMax = 3;

export type SparkLine = { key: string; color: string; dashed: boolean; vals: Array<number | null> };

/** The lines a metric result draws, on the panel's bars. */
export function sparkLines(times: readonly string[], result: SearchAggResult | null): SparkLine[] {
  if (!result || result.source === "refused") {
    return [];
  }
  if (result.splits) {
    return result.splits.map((s, i) => ({
      key: s.key,
      color: s.key === "other" ? otherColor : splitPalette[i % splitPalette.length]!,
      dashed: s.key === "other",
      vals: alignAggBuckets(times, s.buckets),
    }));
  }
  return [{ key: "", color: LINE, dashed: false, vals: alignAggBuckets(times, result.buckets) }];
}

/** The bars' times, or the series' own when the panel has no log bars to borrow. */
export function sparkTimes(barTimes: readonly string[], result: SearchAggResult | null): string[] {
  if (barTimes.length > 0) {
    return [...barTimes];
  }
  const all = new Set<string>();
  for (const b of result?.buckets ?? []) all.add(b.t);
  for (const s of result?.splits ?? []) for (const b of s.buckets) all.add(b.t);
  return [...all].sort();
}

/** A line's last value in the window: what its end label and legend say. */
export function lastValue(vals: ReadonlyArray<number | null>): number | null {
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** End labels pushed apart so two lines that end close still read (13a's disk panel). */
export function spreadLabels(ys: number[], gap: number, height: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const item of order) {
    const y = Math.max(item.y, prev + gap);
    out[item.i] = y;
    prev = y;
  }
  // Pulled back up when the last one ran off the bottom.
  const over = prev - height;
  if (over > 0) {
    for (const item of order) out[item.i] = Math.max(0, out[item.i]! - over);
  }
  return out;
}

function clock(iso: string, seconds: boolean): string {
  return iso.slice(11, seconds ? 19 : 16);
}

/**
 * A metric panel's plot (#104): one line, or one per value of a split; its peak and 0 on the
 * axis with the unit; what it reads now; a hover that says each line's value.
 */
export function MetricSpark({
  times,
  result,
  readingWord,
  kindWord,
  name,
  window,
  live,
}: {
  times: string[];
  result: SearchAggResult | null;
  /** `avg`, `sum / 1m`, `p99`. */
  readingWord: string;
  kindWord: string;
  name: string;
  window: string;
  live: boolean;
}) {
  const lines = useMemo(() => sparkLines(times, result), [times, result]);
  const unit = result?.unit;
  const finite = lines.flatMap((l) => l.vals.filter((v): v is number => v !== null));
  const quiet = finite.length === 0;
  // Some room above the highest line, so it does not sit on the panel's edge.
  const peak = quiet ? 1 : Math.max(1e-9, ...finite) * 1.15;
  const n = times.length;
  const step = n > 1 ? Date.parse(times[1]!) - Date.parse(times[0]!) : 60_000;
  const seconds = step < 60_000;
  const split = Boolean(result?.splits);
  const named = split && lines.length <= endLabelMax;
  const legend = split && lines.length > endLabelMax;

  // Live keeps a resting pointer on its bar: held by time, not by position (13i).
  const [hoverT, setHoverT] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotH, setPlotH] = useState(120);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPlotH(el.clientHeight));
    ro.observe(el);
    setPlotH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const hoverIdx = hoverT ? times.indexOf(hoverT) : -1;

  const x = (i: number) => ((i + 0.5) / Math.max(1, n)) * 100;
  const y = (v: number) => 100 - (v / peak) * 100;
  const points = (vals: ReadonlyArray<number | null>) =>
    vals
      .map((v, i) => (v === null ? null : `${x(i).toFixed(2)},${y(v).toFixed(2)}`))
      .filter((p): p is string => p !== null)
      .join(" ");

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (n === 0 || rect.width <= 0) return;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
    setHoverT(times[i] ?? null);
  }

  const single = lines[0];
  const now = single ? lastValue(single.vals) : null;
  const tag = quiet
    ? [readingWord, kindWord, "no points"].join(" · ")
    : split
      ? [readingWord, kindWord].join(" · ")
      : [readingWord, kindWord, kindWord === "gauge" ? `now ${withUnit(formatAggStat(now), unit)}` : `peak ${withUnit(formatAggStat(peak), unit)}`].join(" · ");

  const labelYs = named
    ? spreadLabels(
        lines.map((l) => {
          const v = lastValue(l.vals);
          return v === null ? 0 : (y(v) / 100) * plotH - 7;
        }),
        13,
        Math.max(0, plotH - 13),
      )
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-1.5">
      <span className={`pl-12 font-mono text-[10.5px] ${quiet ? "text-amber-400" : "text-muted-foreground"}`}>{tag}</span>
      <div className="relative mt-1 flex min-h-0 flex-1">
        <div className="flex w-12 shrink-0 flex-col justify-between pr-1.5 text-right font-mono text-[10px] leading-none whitespace-nowrap text-muted-foreground">
          <span>{quiet ? "" : withUnit(formatAggStat(peak), unit)}</span>
          <span className="text-muted-foreground/60">0</span>
        </div>
        <div
          ref={plotRef}
          className={`relative min-w-0 flex-1 border-b border-white/[0.12] ${named ? "mr-[92px]" : ""}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {quiet ? (
            <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[11.5px] leading-snug text-pretty text-amber-400">
              No points for {name} in this window{window ? ` (last ${window})` : ""}. The line is missing, not zero.
            </span>
          ) : (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 block h-full w-full overflow-visible" aria-hidden>
              {lines.map((l) => (
                <polyline
                  key={l.key || "line"}
                  points={points(l.vals)}
                  fill="none"
                  stroke={l.color}
                  strokeWidth="1.4"
                  strokeDasharray={l.dashed ? "3 3" : undefined}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          )}
          {named
            ? lines.map((l, i) => (
                <span
                  key={l.key}
                  className="absolute left-full ml-1.5 w-[88px] truncate font-mono text-[10.5px]"
                  style={{ top: `${labelYs[i] ?? 0}px`, color: l.color }}
                >
                  {l.key} {formatAggStat(lastValue(l.vals))}
                </span>
              ))
            : null}
          {hoverIdx >= 0 && !quiet ? (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px bg-white/35" style={{ left: `${x(hoverIdx)}%` }} />
              {lines.map((l) => {
                const v = l.vals[hoverIdx];
                return v === null || v === undefined ? null : (
                  <span
                    key={l.key || "dot"}
                    className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_#111113]"
                    style={{ left: `${x(hoverIdx)}%`, top: `${y(v)}%`, background: l.color }}
                  />
                );
              })}
              <div
                role="status"
                className="pointer-events-none absolute top-[6%] z-10 flex flex-col gap-0.5 rounded-[6.4px] border border-white/12 bg-[#18181b] px-2 py-1.5 font-mono text-[11px] leading-[17px] whitespace-nowrap shadow-[0_6px_18px_rgba(0,0,0,0.5)]"
                style={
                  x(hoverIdx) > 55
                    ? { right: `calc(${100 - x(hoverIdx)}% + 14px)` }
                    : { left: `calc(${x(hoverIdx)}% + 14px)` }
                }
              >
                <span className="text-muted-foreground">
                  {clock(times[hoverIdx]!, seconds)}–{clock(new Date(Date.parse(times[hoverIdx]!) + step).toISOString(), seconds)}
                  {split ? ` · ${readingWord}` : ""}
                </span>
                {split ? (
                  lines.map((l) => (
                    <span key={l.key} className="flex items-center gap-2">
                      <span className="h-0 w-2.5 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? "dashed" : "solid" }} />
                      <span className="w-16 truncate">{l.key}</span>
                      <span>{withUnit(formatAggStat(l.vals[hoverIdx] ?? null), unit)}</span>
                    </span>
                  ))
                ) : (
                  <span>
                    <span className="text-muted-foreground">{readingWord}</span>{" "}
                    {withUnit(formatAggStat(single?.vals[hoverIdx] ?? null), unit)}
                  </span>
                )}
                {live ? <span className="font-sans text-[10.5px] text-muted-foreground">held on this bar while the plot moves</span> : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      {legend ? (
        <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-0.5 pl-12 font-mono text-[10.5px]">
          {lines.map((l) => (
            <span key={l.key} className="flex min-w-0 items-center gap-1.5">
              <span className="h-0 w-3 shrink-0 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? "dashed" : "solid" }} />
              <span className="min-w-0 truncate">{l.key}</span>
              <span className="ml-auto text-muted-foreground">{formatAggStat(lastValue(l.vals))}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Frame 13f: a metric panel splits by one of its label keys, or none. */
export function MetricSplitPicker({
  metric,
  value,
  onChange,
}: {
  metric: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const catalog = useSeriesCatalog();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<Array<{ key: string; values: number }> | null>(null);
  useEffect(() => {
    if (!open || !catalog.labels) return;
    let live = true;
    setKeys(null);
    void catalog.labels(metric).then((rows) => {
      if (live) setKeys(rows);
    });
    return () => {
      live = false;
    };
  }, [open, metric, catalog]);
  const row = "flex h-[30px] w-full items-center gap-2 rounded-[4px] px-2 text-left text-[12.5px] hover:bg-accent";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-input bg-[#18181b] px-2 font-mono text-[11.5px]"
        >
          {value ?? "None"}
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] bg-[#18181b] p-1" role="listbox" aria-label="Split by">
        <div className="flex justify-between px-2 pt-1.5 pb-1 text-[10.5px] tracking-[0.06em] text-muted-foreground">
          <span>SPLIT BY</span>
          <span className="tracking-normal">labels in this window{catalog.window ? ` · ${catalog.window}` : ""}</span>
        </div>
        <button type="button" role="option" aria-selected={value === null} className={row} onClick={() => { onChange(null); setOpen(false); }}>
          <span className="w-3 text-muted-foreground">{value === null ? "✓" : ""}</span>
          <span className="flex-1">None</span>
          <span className="text-[11.5px] text-muted-foreground">one line</span>
        </button>
        {keys === null ? (
          <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">Reading labels…</div>
        ) : keys.length === 0 ? (
          <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">This metric has no labels in this window.</div>
        ) : (
          keys.map((k) => (
            <button
              key={k.key}
              type="button"
              role="option"
              aria-selected={value === k.key}
              className={row}
              onClick={() => {
                onChange(k.key);
                setOpen(false);
              }}
            >
              <span className="w-3 text-muted-foreground">{value === k.key ? "✓" : ""}</span>
              <span className="flex-1 font-mono">{k.key}</span>
              <span className="text-[11.5px] text-muted-foreground">
                {k.values} value{k.values === 1 ? "" : "s"}
                {k.values > 8 ? " · 8 and other" : ""}
              </span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
