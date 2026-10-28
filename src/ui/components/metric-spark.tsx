import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatAggStat } from "@/fill-histogram";
import type { SearchAggResult } from "@/types";
import { alignAggBuckets } from "../../query/agg";
import { useSeriesCatalog } from "../series-catalog";
import { unitChangeMark, unitChanges, withUnit } from "../metric-unit";
import { darkPlotTheme, usePlotTheme, type PlotTheme } from "../plot-theme";
import type { MetricHeld } from "../held-view";
import { HeldHatch } from "./held-hatch";
import { MarkGlyph, markKindColor } from "./histogram-marks";
import type { ChangeMark } from "../../shared/change-mark";

/** One line per value of a split (frames 13e, 13g); the sixth colour is not `other`'s grey. */
export const splitPalette = darkPlotTheme.palette;
export const otherColor = darkPlotTheme.other;
/** Up to this many lines are named at their ends; more get a legend (13g). */
export const endLabelMax = 3;

export type SparkLine = {
  key: string;
  color: string;
  dashed: boolean;
  vals: Array<number | null>;
  /** A line split out by its unit (#331): its own, over the panel's. */
  unit?: string;
};

/** The lines a metric result draws, on the panel's bars. */
export function sparkLines(
  times: readonly string[],
  result: SearchAggResult | null,
  theme: PlotTheme = darkPlotTheme,
): SparkLine[] {
  if (!result || result.source === "refused") {
    return [];
  }
  if (result.splits) {
    return result.splits.map((s, i) => ({
      key: s.key,
      color: s.key === "other" ? theme.other : theme.palette[i % theme.palette.length]!,
      dashed: s.key === "other",
      vals: alignAggBuckets(times, s.buckets),
      ...(s.unit ? { unit: s.unit } : {}),
    }));
  }
  return [{ key: "", color: theme.line, dashed: false, vals: alignAggBuckets(times, result.buckets) }];
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

export type BarRect = { key: string; color: string; x: number; y: number; w: number; h: number };

/**
 * A metric panel's bars (#237, 25b, 25c) in the plot's 0–100 box: one bar per bucket, a split's
 * bars side by side, or stacked when `stacked` (their sum is the bar's height).
 */
export function barRects(lines: readonly SparkLine[], n: number, peak: number, stacked: boolean): BarRect[] {
  if (n === 0 || lines.length === 0 || !(peak > 0)) {
    return [];
  }
  const slot = 100 / n;
  const pad = Math.min(slot * 0.15, 0.6);
  const out: BarRect[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = i * slot + pad;
    const wAll = slot - 2 * pad;
    if (stacked) {
      let base = 0;
      for (const l of lines) {
        const v = l.vals[i];
        if (v === null || v === undefined || v <= 0) continue;
        const h = (v / peak) * 100;
        out.push({ key: l.key, color: l.color, x: x0, y: 100 - base - h, w: wAll, h });
        base += h;
      }
    } else {
      const w = wAll / lines.length;
      lines.forEach((l, k) => {
        const v = l.vals[i];
        if (v === null || v === undefined || v <= 0) return;
        const h = (v / peak) * 100;
        out.push({ key: l.key, color: l.color, x: x0 + k * w, y: 100 - h, w, h });
      });
    }
  }
  return out;
}

/** The tallest bar of a stack: each bucket's sum. */
export function stackedPeak(lines: readonly SparkLine[], n: number): number {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, lines.reduce((sum, l) => sum + Math.max(0, l.vals[i] ?? 0), 0));
  }
  return peak;
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
type SparkProps = {
  times: string[];
  result: SearchAggResult | null;
  readingWord: string;
  kindWord: string;
  name: string;
  window: string;
  live: boolean;
  namedLines?: boolean;
  chart?: "line" | "bars" | "stacked";
  /** A source short inside the window (#331). */
  held?: MetricHeld | null;
  /** The panel's marks (#331, 33e): a deploy a unit changed around is drawn where the old line ends. */
  marks?: readonly ChangeMark[];
};

/** One unit's scale in a plot whose lines came in more than one unit: its peak and the colour of its first line. */
export type UnitAxis = { unit: string; peak: number; color: string };

/**
 * The scales of a plot whose lines came in more than one unit (#331, 33e): its lines share the
 * plot, each drawn against its own unit's peak, so ms and s are never read off one axis. Null
 * when its lines share a unit.
 */
export function unitAxes(lines: readonly SparkLine[]): UnitAxis[] | null {
  const units = [...new Set(lines.map((l) => l.unit ?? ""))];
  if (units.length < 2) {
    return null;
  }
  return units.map((unit) => {
    const mine = lines.filter((l) => (l.unit ?? "") === unit);
    const finite = mine.flatMap((l) => l.vals.filter((v): v is number => v !== null));
    // Some room above the highest line, as one axis has.
    const peak = finite.length === 0 ? 1 : Math.max(1e-9, ...finite) * 1.15;
    return { unit, peak, color: mine[0]!.color };
  });
}

/** A metric panel's plot: a histogram read as a heatmap (#238) paints its cells, anything else its lines or bars. */
export function MetricSpark(props: SparkProps) {
  if (props.result?.heat) {
    return <HeatSpark result={props.result} readingWord={props.readingWord} />;
  }
  return <LineSpark {...props} />;
}

function LineSpark({
  times,
  result,
  readingWord,
  kindWord,
  name,
  window,
  live,
  namedLines = false,
  chart = "line",
  held = null,
  marks,
}: {
  times: string[];
  result: SearchAggResult | null;
  /** `avg`, `sum / 1m`, `p99`. */
  readingWord: string;
  kindWord: string;
  name: string;
  window: string;
  live: boolean;
  /** Lines given names (#169): said in a legend under the plot, with their values (17b). */
  namedLines?: boolean;
  /** Lines, bars, or a split's bars stacked (#237). */
  chart?: "line" | "bars" | "stacked";
  /** A source short inside the window (#331): its span hatched; an average or a percentile named partial. */
  held?: MetricHeld | null;
  marks?: readonly ChangeMark[];
}) {
  const theme = usePlotTheme();
  const lines = useMemo(() => sparkLines(times, result, theme), [times, result, theme]);
  const unit = result?.unit;
  const finite = lines.flatMap((l) => l.vals.filter((v): v is number => v !== null));
  const quiet = finite.length === 0;
  // Lines in more than one unit share the plot, each on its own unit's scale (#331, 33e); they never stack.
  const axes = unitAxes(lines);
  const n = times.length;
  const stacked = chart === "stacked" && lines.length > 1 && !axes;
  // Some room above the highest line, so it does not sit on the panel's edge.
  const peak = quiet ? 1 : Math.max(1e-9, stacked ? stackedPeak(lines, n) : Math.max(...finite)) * 1.15;
  const peakOf = (l: SparkLine) => axes?.find((a) => a.unit === (l.unit ?? ""))?.peak ?? peak;
  const bars =
    chart === "line"
      ? null
      : axes
        ? barRects(lines.map((l) => ({ ...l, vals: l.vals.map((v) => (v === null ? null : v / peakOf(l))) })), n, 1, false)
        : barRects(lines, n, peak, stacked);
  const step = n > 1 ? Date.parse(times[1]!) - Date.parse(times[0]!) : 60_000;
  const seconds = step < 60_000;
  const split = Boolean(result?.splits);
  // Bars are named in a legend: an end label would sit on the last bar.
  const named = split && lines.length <= endLabelMax && !namedLines && chart === "line";
  const legend = split && (lines.length > endLabelMax || namedLines || chart !== "line");

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
  const yOf = (l: SparkLine) => (v: number) => 100 - (v / peakOf(l)) * 100;
  const points = (l: SparkLine) =>
    l.vals
      .map((v, i) => (v === null ? null : `${x(i).toFixed(2)},${yOf(l)(v).toFixed(2)}`))
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
  const partial = held && !held.floor ? ["partial"] : [];
  const tag = quiet
    ? [readingWord, kindWord, "no points"].join(" · ")
    : split
      ? [readingWord, kindWord, ...partial].join(" · ")
      : [
          readingWord,
          kindWord,
          kindWord === "gauge" ? `now ${withUnit(formatAggStat(now), unit)}` : `peak ${withUnit(formatAggStat(peak), unit)}`,
          ...partial,
        ].join(" · ");

  const labelYs = named
    ? spreadLabels(
        lines.map((l) => {
          const v = lastValue(l.vals);
          return v === null ? 0 : (yOf(l)(v) / 100) * plotH - 7;
        }),
        13,
        Math.max(0, plotH - 13),
      )
    : [];

  // A unit changed at one source (#331, 33e): the deploy it changed around, where the old line ends.
  const t0 = n > 0 ? Date.parse(times[0]!) : 0;
  const changeMarks = quiet || n === 0
    ? []
    : (unitChanges(result?.units_differ) ?? [])
        .map((change) => unitChangeMark(change, marks))
        .filter((mark): mark is ChangeMark => mark !== null)
        .map((mark) => ({ ...mark, at: ((Date.parse(mark.ts) - t0) / (n * step)) * 100 }))
        .filter((mark) => mark.at >= 0 && mark.at <= 100);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-1.5">
      <span className={`pl-12 font-mono text-[10.5px] ${quiet ? "text-amber-400" : "text-muted-foreground"}`}>{tag}</span>
      <div className="relative mt-1 flex min-h-0 flex-1">
        <div className="flex w-12 shrink-0 flex-col justify-between pr-1.5 text-right font-mono text-[10px] leading-none whitespace-nowrap text-muted-foreground">
          {axes && !quiet ? (
            // Each unit's peak in the colour of its line: two scales, said where the one would be.
            <span className="flex flex-col gap-1" aria-label={`scales: ${axes.map((a) => withUnit(formatAggStat(a.peak), a.unit)).join(", ")}`}>
              {axes.map((a) => (
                <span key={a.unit} style={{ color: a.color }}>
                  {withUnit(formatAggStat(a.peak), a.unit)}
                </span>
              ))}
            </span>
          ) : (
            <span>{quiet ? "" : withUnit(formatAggStat(peak), unit)}</span>
          )}
          <span className="text-muted-foreground/60">0</span>
        </div>
        <div
          ref={plotRef}
          className={`relative min-w-0 flex-1 border-b border-[var(--plot-axis)] ${named ? "mr-[92px]" : ""}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {quiet ? (
            <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[11.5px] leading-snug text-pretty text-amber-400">
              No points for {name} in this window{window ? ` (last ${window})` : ""}. The line is missing, not zero.
            </span>
          ) : (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 block h-full w-full overflow-visible" aria-hidden>
              {bars
                ? bars.map((b, i) => (
                    <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.color} opacity={b.key === "other" ? 0.6 : 1} />
                  ))
                : lines.map((l) => (
                <polyline
                  key={l.key || "line"}
                  points={points(l)}
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
          {held && held.hatches.length > 0 && n > 0 ? (
            <HeldHatch spans={held.hatches} fromMs={Date.parse(times[0]!)} plotSpanMs={n * step} />
          ) : null}
          {changeMarks.map((mark) => (
            <span
              key={mark.id}
              className="pointer-events-none absolute inset-y-0 w-px"
              style={{ left: `${mark.at}%`, background: markKindColor(mark.kind) }}
            >
              <span
                className={`absolute top-0 flex items-center gap-1 font-mono text-[10px] whitespace-nowrap ${mark.at > 70 ? "right-1.5" : "left-1.5"}`}
                style={{ color: markKindColor(mark.kind) }}
              >
                <MarkGlyph kind={mark.kind} size={9} />
                {mark.title} · {clock(mark.ts, false)}
              </span>
            </span>
          ))}
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
              <span className="pointer-events-none absolute inset-y-0 w-px bg-[var(--plot-hair)]" style={{ left: `${x(hoverIdx)}%` }} />
              {lines.map((l) => {
                const v = l.vals[hoverIdx];
                return v === null || v === undefined ? null : (
                  <span
                    key={l.key || "dot"}
                    className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_var(--plot-ring)]"
                    style={{ left: `${x(hoverIdx)}%`, top: `${yOf(l)(v)}%`, background: l.color }}
                  />
                );
              })}
              <div
                role="status"
                className="pointer-events-none absolute top-[6%] z-10 flex flex-col gap-0.5 rounded-[6.4px] border border-[var(--plot-axis)] bg-[var(--plot-pop)] px-2 py-1.5 font-mono text-[11px] leading-[17px] whitespace-nowrap shadow-[0_6px_18px_rgba(0,0,0,0.5)]"
                style={
                  x(hoverIdx) > 55
                    ? { right: `calc(${100 - x(hoverIdx)}% + 14px)` }
                    : { left: `calc(${x(hoverIdx)}% + 14px)` }
                }
              >
                <span className="text-muted-foreground">
                  {clock(times[hoverIdx]!, seconds)}–{clock(new Date(Date.parse(times[hoverIdx]!) + step).toISOString(), seconds)}
                  {split ? ` · ${readingWord}` : ""}
                  {stacked
                    ? ` · total ${withUnit(formatAggStat(lines.reduce((sum, l) => sum + Math.max(0, l.vals[hoverIdx] ?? 0), 0)), unit)}`
                    : ""}
                </span>
                {split ? (
                  lines.map((l) => (
                    <span key={l.key} className="flex items-center gap-2">
                      <span className="h-0 w-2.5 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? "dashed" : "solid" }} />
                      <span className="w-16 truncate">{l.key}</span>
                      <span>{withUnit(formatAggStat(l.vals[hoverIdx] ?? null), l.unit ?? unit)}</span>
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
      {legend && namedLines ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-12 text-[11.5px]">
          {lines.map((l) => (
            <span key={l.key} className="flex min-w-0 items-center gap-1.5">
              <span className="h-0 w-3 shrink-0 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? "dashed" : "solid" }} />
              <span className="min-w-0 truncate">{l.key}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{withUnit(formatAggStat(lastValue(l.vals)), l.unit ?? unit)}</span>
            </span>
          ))}
        </div>
      ) : legend ? (
        <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-0.5 pl-12 font-mono text-[10.5px]">
          {lines.map((l) => (
            <span key={l.key} className="flex min-w-0 items-center gap-1.5">
              <span className="h-0 w-3 shrink-0 border-t-2" style={{ borderColor: l.color, borderStyle: l.dashed ? "dashed" : "solid" }} />
              <span className="min-w-0 truncate">{l.key}</span>
              <span className="ml-auto text-muted-foreground">
                {axes ? withUnit(formatAggStat(lastValue(l.vals)), l.unit) : formatAggStat(lastValue(l.vals))}
              </span>
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

/**
 * Line · Bars · Stacked in a metric panel's head (#237, 25a). Stacked adds parts up, so it is
 * offered only where they do (a counter, a histogram's count or sum, with a split); otherwise it is
 * disabled and says why (25d).
 */
export function MetricChartPicker({
  value,
  stackable,
  onChange,
}: {
  value: "line" | "bars" | "stacked";
  /** True, or why a stack would not add up. */
  stackable: true | string;
  onChange: (next: "line" | "bars" | "stacked") => void;
}) {
  const options = [
    ["line", "Line"],
    ["bars", "Bars"],
    ["stacked", "Stacked"],
  ] as const;
  return (
    <div role="group" aria-label="Chart" className="flex shrink-0 overflow-hidden rounded-[4.4px] border border-input" onPointerDown={(e) => e.stopPropagation()}>
      {options.map(([id, label], i) => {
        const off = id === "stacked" && stackable !== true;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            disabled={off}
            title={off ? stackable : undefined}
            className={`h-[22px] px-2 text-[11.5px] ${i > 0 ? "border-l border-input" : ""} ${
              value === id ? "bg-plate/15 text-foreground" : "text-muted-foreground hover:text-foreground"
            } disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:hover:text-muted-foreground/40`}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Whether a metric's bars may stack (#237): their parts must add up to the bar. */
export function metricStackable(result: { kind?: string; reading?: string } | null, split: string | null): true | string {
  const adds = result?.kind === "counter" || (result?.kind === "histogram" && (result.reading === "count" || result.reading === "sum"));
  if (!adds) {
    return "Stacking adds parts up. An average's or a percentile's parts do not add up to anything, so this draws as lines or bars side by side.";
  }
  return split ? true : "Stacked needs a split: one part per value of a label.";
}

/** Where a value sits on a heatmap's rows, as a fraction from the bottom: inside the first bound at or above it. */
export function heatRowFraction(le: readonly number[], v: number): number {
  const rows = le.length;
  const j = le.findIndex((bound) => v <= bound);
  const row = j < 0 ? rows - 1 : j;
  const lower = row === 0 ? 0 : le[row - 1]!;
  const upper = Number.isFinite(le[row]!) ? le[row]! : lower * 2 || 1;
  const within = upper > lower ? Math.min(1, Math.max(0, (v - lower) / (upper - lower))) : 0.5;
  return (row + within) / rows;
}

function boundWord(b: number, unit: string | undefined): string {
  return Number.isFinite(b) ? withUnit(formatAggStat(b), unit) : "above";
}

/**
 * A histogram metric as a heatmap (#238, 25e, 25f): a column per bar, a row per bucket bound, the
 * shade its count on a log scale; its p99 drawn over it; hover a cell for its bar, range and count.
 */
function HeatSpark({ result, readingWord }: { result: SearchAggResult; readingWord: string }) {
  const theme = usePlotTheme();
  const heat = result.heat!;
  const unit = result.unit;
  const [p99On, setP99On] = useState(true);
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const cols = heat.cells.length;
  const rows = heat.le.length;
  const max = Math.max(1, ...heat.cells.flatMap((c) => c.n));
  const hue = theme.name === "light" ? "37,99,235" : "56,189,248";
  const shade = (c: number) => (c <= 0 ? 0.04 : 0.08 + 0.92 * (Math.log1p(c) / Math.log1p(max)));
  const times = heat.cells.map((c) => c.t);
  const p99 = alignAggBuckets(times, result.buckets);
  const p99Points = p99
    .map((v, i) => (v === null ? null : `${(((i + 0.5) / Math.max(1, cols)) * 100).toFixed(2)},${(100 - heatRowFraction(heat.le, v) * 100).toFixed(2)}`))
    .filter((p): p is string => p !== null)
    .join(" ");
  const finiteLe = heat.le.filter((b) => Number.isFinite(b));
  const cell = hover ? heat.cells[hover.i] : null;
  const barTotal = cell ? cell.n.reduce((a, b) => a + b, 0) : 0;
  const step = cols > 1 ? Date.parse(times[1]!) - Date.parse(times[0]!) : 60_000;
  const clock = (iso: string) => iso.slice(11, step < 60_000 ? 19 : 16);

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (cols === 0 || rows === 0 || rect.width <= 0) return;
    const i = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * cols)));
    const j = Math.min(rows - 1, Math.max(0, rows - 1 - Math.floor(((e.clientY - rect.top) / rect.height) * rows)));
    setHover({ i, j });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-1.5">
      <div className="flex items-center gap-3 pl-12">
        <span className="font-mono text-[10.5px] text-muted-foreground">{readingWord} · histogram · log shade</span>
        <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <input type="checkbox" checked={p99On} onChange={(e) => setP99On(e.target.checked)} className="accent-[var(--color-plate)]" />
          p99 over it
        </label>
      </div>
      <div className="relative mt-1 flex min-h-0 flex-1">
        <div className="flex w-12 shrink-0 flex-col justify-between pr-1.5 text-right font-mono text-[10px] leading-none whitespace-nowrap text-muted-foreground">
          <span>{finiteLe.length ? `>${boundWord(finiteLe[finiteLe.length - 1]!, unit)}` : ""}</span>
          <span>{finiteLe.length > 2 ? boundWord(finiteLe[Math.floor(finiteLe.length / 2)]!, unit) : ""}</span>
          <span>{finiteLe.length ? boundWord(finiteLe[0]!, unit) : ""}</span>
        </div>
        <div className="relative min-w-0 flex-1" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {cols === 0 ? (
            <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[11.5px] text-amber-400">No buckets in this window.</span>
          ) : (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 block h-full w-full" aria-hidden>
              {heat.cells.map((c, i) =>
                c.n.map((count, j) => (
                  <rect
                    key={`${i}-${j}`}
                    x={(i / cols) * 100}
                    y={((rows - 1 - j) / rows) * 100}
                    width={100 / cols - 0.15}
                    height={100 / rows - 0.3}
                    fill={`rgba(${hue},${shade(count).toFixed(3)})`}
                    stroke={hover && hover.i === i && hover.j === j ? "var(--foreground)" : undefined}
                    strokeWidth={0.4}
                    vectorEffect="non-scaling-stroke"
                  />
                )),
              )}
              {p99On && p99Points ? (
                <polyline points={p99Points} fill="none" stroke="#fbbf24" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              ) : null}
            </svg>
          )}
          {cell && hover ? (
            <div
              role="status"
              className="pointer-events-none absolute top-[6%] z-10 flex flex-col gap-0.5 rounded-[6.4px] border border-[var(--plot-axis)] bg-[var(--plot-pop)] px-2 py-1.5 font-mono text-[11px] leading-[17px] whitespace-nowrap shadow-[0_6px_18px_rgba(0,0,0,0.5)]"
              style={hover.i / cols > 0.55 ? { right: `calc(${100 - (hover.i / cols) * 100}% + 14px)` } : { left: `calc(${((hover.i + 1) / cols) * 100}% + 14px)` }}
            >
              <span className="text-muted-foreground">
                {clock(cell.t)}–{clock(new Date(Date.parse(cell.t) + step).toISOString())}
              </span>
              <span>
                {hover.j === 0 ? "0" : boundWord(heat.le[hover.j - 1]!, unit)} – {boundWord(heat.le[hover.j]!, unit)} ·{" "}
                {formatAggStat(cell.n[hover.j] ?? 0)}
              </span>
              <span className="text-muted-foreground">
                {barTotal > 0 ? `${Math.round(((cell.n[hover.j] ?? 0) / barTotal) * 100)}% of the bar` : "nothing in this bar"}
                {p99[hover.i] !== null && p99[hover.i] !== undefined ? ` · p99 ${withUnit(formatAggStat(p99[hover.i]!), unit)}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
