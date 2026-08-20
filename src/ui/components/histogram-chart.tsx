import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  abbrevCount,
  bucketIndexAt,
  formatAggStat,
  formatSeriesTotal,
  histogramAxisLabels,
  histogramAxisTick,
  histogramWindowNeedsDate,
  histogramYTicks,
  resolveHistogramStepMs,
  scaleCount,
  stackedSegmentPlotFrac,
} from "@/fill-histogram";
import {
  seriesColor,
  seriesKeys,
  seriesTotal,
  seriesValue,
} from "@/histogram-series";
import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/keyboard";
import type { HistogramBucket, SearchAggResult } from "@/types";
import { WidgetExportMenu } from "@/components/widget-export-menu";
import {
  downloadWidgetSeries,
  histogramExport,
} from "@/export-series";
import { alignAggBuckets, finiteAggPeak } from "../../query/agg";
import {
  histogramCharts,
  histogramIntervalMsById,
  histogramSplits,
  type HistogramChartKind,
  type HistogramIntervalId,
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
import { formatSpanShort } from "../time-range";
import {
  clickHistogramWindow,
  displayedHistogramInterval,
  dragHistogramWindow,
  histogramHoverHint,
  histogramRetentionMs,
  panHistogramWindow,
  snapHistogramSpanMs,
  zoomHistogramAbout,
} from "../histogram-zoom";
import { HistogramIntervalChips } from "./histogram-interval";

const HOVER_GAP_PX = 12;
const PLOT_H = 104;
const HEAD_H = 12;
const HEAD_GAP = 2;
const AGG_COLOR = "#a78bfa";

type Props = {
  buckets: HistogramBucket[];
  loading: boolean;
  live: boolean;
  split: HistogramSplit;
  chart: HistogramChartKind;
  logScale: boolean;
  onSplit: (split: HistogramSplit) => void;
  onChart: (chart: HistogramChartKind) => void;
  onToggleScale: () => void;
  onWindow: (fromIso: string, toIso: string) => void;
  spanMs: number;
  interval: HistogramIntervalId | null;
  onInterval: (next: HistogramIntervalId | null) => void;
  anchorTs?: string | null;
  agg: string | null;
  onAgg: (next: string | null) => void;
  metric: string | null;
  metricLabels?: Record<string, string>;
  onSeries: (next: { agg: string | null; metric: string | null }) => void;
  onClearMetricLabels?: () => void;
  replaceY: boolean;
  onReplaceY: (on: boolean) => void;
  aggResult: SearchAggResult | null;
  numericKeys: string[];
  metricNames: string[];
  updated?: ReactNode;
  className?: string;
  compactToolbar?: boolean;
  lockChrome?: boolean;
  retentionMs?: number;
  scanReason?: string | null;
};

function bucketEndMs(bucket: HistogramBucket, stepMs: number): number {
  return Date.parse(bucket.t) + stepMs;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function pill(on: boolean): string {
  return cn(
    "h-[22px] rounded-sm px-2 text-[12px]",
    on
      ? "bg-accent text-foreground"
      : "bg-transparent text-muted-foreground hover:text-foreground",
  );
}

function svgAreaPath(xs: number[], yTop: number[], yBot: number[]): string {
  if (xs.length === 0) {
    return "";
  }
  const top = xs.map((x, i) => `${x.toFixed(1)},${(yTop[i] ?? PLOT_H).toFixed(1)}`);
  const bot: string[] = [];
  for (let i = xs.length - 1; i >= 0; i--) {
    bot.push(`${xs[i]!.toFixed(1)},${(yBot[i] ?? PLOT_H).toFixed(1)}`);
  }
  return `M${top.join(" L")} L${bot.join(" L")} Z`;
}

function overlayY(
  v: number | null,
  peak: number,
  logScale: boolean,
): number | null {
  if (v === null || !Number.isFinite(v)) {
    return null;
  }
  return PLOT_H - scaleCount(v, peak, logScale) * PLOT_H;
}

function overlayLineSegments(
  xs: number[],
  values: ReadonlyArray<number | null>,
  peak: number,
  logScale: boolean,
): string[] {
  const segs: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const y = overlayY(values[i] ?? null, peak, logScale);
    if (y === null) {
      if (cur.length > 0) {
        segs.push(cur.join(" "));
        cur = [];
      }
      continue;
    }
    cur.push(`${xs[i]!.toFixed(1)},${y.toFixed(1)}`);
  }
  if (cur.length > 0) {
    segs.push(cur.join(" "));
  }
  return segs;
}

function overlayAreaSegments(
  xs: number[],
  values: ReadonlyArray<number | null>,
  peak: number,
  logScale: boolean,
): string[] {
  const segs: string[] = [];
  let runXs: number[] = [];
  let runYs: number[] = [];
  const flush = () => {
    if (runXs.length === 0) {
      return;
    }
    segs.push(svgAreaPath(runXs, runYs, runXs.map(() => PLOT_H)));
    runXs = [];
    runYs = [];
  };
  for (let i = 0; i < values.length; i++) {
    const y = overlayY(values[i] ?? null, peak, logScale);
    if (y === null) {
      flush();
      continue;
    }
    runXs.push(xs[i]!);
    runYs.push(y);
  }
  flush();
  return segs;
}

function HistogramHover({
  bucket,
  rangeLabel,
  keys,
  split,
  left,
  side,
  overlay,
  hint,
}: {
  bucket: HistogramBucket;
  rangeLabel: string;
  keys: string[];
  split: HistogramSplit;
  left: number | string;
  side: "left" | "right";
  overlay?: { label: string; v: number | null } | null;
  hint: string;
}) {
  const lines = keys
    .map((key) => ({ key, n: seriesValue(bucket, key, split) }))
    .filter((row) => row.n > 0);
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-32 rounded-md border bg-popover px-2 py-1.5 text-[11px] shadow-md"
      style={{
        top: HEAD_H + HEAD_GAP + 4,
        left,
        transform: side === "left" ? "translateX(-100%)" : "translateX(0)",
      }}
    >
      <div className="border-b border-border/80 pb-1 font-mono text-[10.5px] tabular-nums">
        {rangeLabel} · {abbrevCount(bucket.n)}
      </div>
      {lines.map((row, i) => (
        <div
          key={row.key}
          className="mt-0.5 flex items-center gap-1.5 text-muted-foreground"
        >
          <span
            className="size-1.5 rounded-[2px]"
            style={{ background: seriesColor(row.key, split, i) }}
          />
          <span className="max-w-24 truncate">{row.key}</span>
          <span className="ml-auto font-mono tabular-nums text-foreground">
            {abbrevCount(row.n)}
          </span>
        </div>
      ))}
      {overlay ? (
        <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <span
            className="size-1.5 rounded-[2px]"
            style={{ background: AGG_COLOR }}
          />
          <span className="max-w-24 truncate">{overlay.label}</span>
          <span className="ml-auto font-mono tabular-nums text-foreground">
            {formatAggStat(overlay.v)}
          </span>
        </div>
      ) : null}
      <div className="mt-1 text-[10px] text-muted-foreground/70">{hint}</div>
    </div>
  );
}

export function HistogramChart({
  buckets,
  loading,
  live,
  split,
  chart,
  logScale,
  onSplit,
  onChart,
  onToggleScale,
  onWindow,
  spanMs,
  interval,
  onInterval,
  anchorTs = null,
  agg,
  onAgg,
  metric,
  metricLabels = {},
  onSeries,
  onClearMetricLabels,
  replaceY,
  onReplaceY,
  aggResult,
  numericKeys,
  metricNames,
  updated = null,
  className,
  compactToolbar = false,
  lockChrome = false,
  retentionMs = histogramRetentionMs,
  scanReason = null,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<{
    start: number;
    end: number;
    id: number;
    head: boolean;
  } | null>(null);
  const panRef = useRef<{
    id: number;
    x0: number;
    d: number;
    from0: number;
    to0: number;
    w: number;
  } | null>(null);
  const hoverRef = useRef<number | null>(null);
  const headArmedRef = useRef(false);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(
    null,
  );
  const [panning, setPanning] = useState(false);
  const [panD, setPanD] = useState(0);
  const [panLock, setPanLock] = useState<{
    d: number;
    fromMs: number;
    toMs: number;
  } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [headArmed, setHeadArmed] = useState(false);
  hoverRef.current = hover;
  headArmedRef.current = headArmed;

  const seriesPick = seriesPickFromWidget(agg, metric);
  const seriesKeysList = pickerNumericKeys(numericKeys, agg);
  const metricNamesList = pickerMetricNames(metricNames, metric);
  const keys = seriesKeys(buckets, split);
  const stacked = chart === "stacked";
  const asLine = chart === "line";
  const asArea = chart === "area";
  const overlayOn =
    Boolean(agg || metric) && aggResult !== null && aggResult.source !== "refused";
  const overlayValues = overlayOn
    ? alignAggBuckets(
        buckets.map((bucket) => bucket.t),
        aggResult?.buckets ?? [],
      )
    : [];
  const overlayPeak = finiteAggPeak(overlayValues);
  const totals = buckets.map((bucket) =>
    stacked || asArea || asLine
      ? bucket.n
      : Math.max(0, ...keys.map((key) => seriesValue(bucket, key, split))),
  );
  const volumePeak = Math.max(1, ...totals);
  const peak = replaceY && overlayOn ? overlayPeak : volumePeak;
  const yTicks = histogramYTicks(peak, logScale);
  const overlayTicks = histogramYTicks(overlayPeak, logScale);
  const stepMs = resolveHistogramStepMs(
    buckets,
    histogramIntervalMsById[displayedHistogramInterval(spanMs, interval, chart)],
  );
  const liveRef = useRef({ buckets, spanMs, stepMs, onWindow, retentionMs });
  liveRef.current = { buckets, spanMs, stepMs, onWindow, retentionMs };
  const hoverBucket = hover !== null ? buckets[hover] : undefined;
  const lo = brush ? Math.min(brush.start, brush.end) : -1;
  const hi = brush ? Math.max(brush.start, brush.end) : -1;
  const binCount = buckets.length;
  const firstBucket = buckets[0];
  const drillMs = snapHistogramSpanMs(stepMs);
  const canDrill = drillMs < spanMs;
  const drillBins = Math.max(1, Math.round(drillMs / stepMs));
  const panPreview =
    panning && panRef.current
      ? panHistogramWindow(
          panRef.current.from0,
          panRef.current.to0,
          -panD * stepMs,
          Date.now(),
          retentionMs,
        )
      : null;
  const previewWin =
    panPreview ??
    panLock ??
    (panning && panRef.current
      ? { fromMs: panRef.current.from0, toMs: panRef.current.to0 }
      : null);
  const sliding = panning || panLock !== null;
  const slideD = panning ? panD : (panLock?.d ?? 0);
  const axisFromMs = previewWin?.fromMs ?? (firstBucket ? Date.parse(firstBucket.t) : NaN);
  const axis = Number.isFinite(axisFromMs)
    ? histogramAxisLabels(axisFromMs, spanMs, live && !sliding, Date.now(), 5, stepMs)
    : [];
  const stampDate = histogramWindowNeedsDate(
    Number.isFinite(axisFromMs) ? axisFromMs : 0,
    spanMs,
    Date.now(),
  );
  const stamp = (ms: number): string =>
    histogramAxisTick(ms, spanMs, { withDate: stampDate, intervalMs: stepMs });
  const hoverFrac =
    hover !== null && binCount > 0 ? (hover + 0.5) / binCount : null;
  const hoverSide =
    hoverFrac !== null && hoverFrac > 0.6 ? "left" : "right";
  const hairlinePct =
    hoverFrac !== null && !brush && !sliding
      ? hoverFrac * 100
      : null;
  const anchorFrac = (() => {
    if (!anchorTs || !firstBucket || spanMs <= 0) {
      return null;
    }
    const t = Date.parse(anchorTs);
    const fromMs = Date.parse(firstBucket.t);
    if (!Number.isFinite(t) || !Number.isFinite(fromMs)) {
      return null;
    }
    const frac = (t - fromMs) / spanMs;
    if (frac < 0 || frac > 1) {
      return null;
    }
    return frac;
  })();

  function indexAt(clientX: number, el: HTMLElement | null): number {
    const count = liveRef.current.buckets.length;
    if (!el || count === 0) {
      return 0;
    }
    const rect = el.getBoundingClientRect();
    return bucketIndexAt(clientX - rect.left, rect.width, count);
  }

  function zoomAt(index: number | null, dir: 1 | -1): void {
    const { buckets: nextBuckets, spanMs: span, stepMs: step, onWindow: setWin } =
      liveRef.current;
    const first = nextBuckets[0];
    if (!first) {
      return;
    }
    const fromMs = Date.parse(first.t);
    const center =
      index === null ? fromMs + span / 2 : fromMs + (index + 0.5) * step;
    const next = zoomHistogramAbout(span, center, dir);
    if (!next) {
      return;
    }
    endGesture();
    setWin(iso(next.fromMs), iso(next.toMs));
  }

  function armHead(on: boolean): void {
    headArmedRef.current = on;
    setHeadArmed(on);
  }

  function endGesture(): void {
    brushRef.current = null;
    panRef.current = null;
    setBrush(null);
    setPanning(false);
    setPanD(0);
    setPanLock(null);
  }

  function commitBrush(start: number, end: number, drill: boolean): void {
    const { buckets: nextBuckets, spanMs: span, stepMs: step, onWindow: setWin } =
      liveRef.current;
    const i0 = Math.min(start, end);
    const i1 = Math.max(start, end);
    const first = nextBuckets[i0];
    const last = nextBuckets[i1];
    if (!first || !last) {
      return;
    }
    const fromMs = Date.parse(first.t);
    const toMs = bucketEndMs(last, step);
    if (i0 === i1) {
      if (!drill) {
        return;
      }
      const clicked = clickHistogramWindow(fromMs, toMs, span);
      if (!clicked) {
        return;
      }
      setWin(iso(clicked.fromMs), iso(clicked.toMs));
      return;
    }
    const drawn = dragHistogramWindow(fromMs, toMs);
    setWin(iso(drawn.fromMs), iso(drawn.toMs));
  }

  function applyPan(d: number): ReturnType<typeof panHistogramWindow> {
    const p = panRef.current;
    if (!p) {
      return null;
    }
    return panHistogramWindow(
      p.from0,
      p.to0,
      -d * liveRef.current.stepMs,
      Date.now(),
      retentionMs,
    );
  }

  function onSurfaceMove(e: { clientX: number; shiftKey: boolean }): void {
    if (brushRef.current || panRef.current || headArmedRef.current) {
      return;
    }
    const i = indexAt(e.clientX, surfaceRef.current);
    const sh = e.shiftKey;
    if (i !== hoverRef.current || sh !== shiftHeld) {
      setHover(i);
      setShiftHeld(sh);
    }
  }

  function onPlotDown(e: { currentTarget: HTMLDivElement; pointerId: number; clientX: number; shiftKey: boolean }): void {
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = indexAt(e.clientX, surfaceRef.current);
    const { buckets: nextBuckets, spanMs: span } = liveRef.current;
    const first = nextBuckets[0];
    if (!first) {
      return;
    }
    if (e.shiftKey) {
      panRef.current = null;
      brushRef.current = { start: i, end: i, id: e.pointerId, head: false };
      setBrush({ start: i, end: i });
      setHover(null);
      armHead(false);
      setPanning(false);
      return;
    }
    brushRef.current = null;
    setBrush(null);
    const from0 = Date.parse(first.t);
    panRef.current = {
      id: e.pointerId,
      x0: e.clientX,
      d: 0,
      from0,
      to0: from0 + span,
      w: e.currentTarget.getBoundingClientRect().width,
    };
    setPanning(true);
    setPanD(0);
    setHover(null);
    armHead(false);
    setShiftHeld(false);
  }

  function onPlotMove(e: { pointerId: number; clientX: number }): void {
    const p = panRef.current;
    if (p) {
      if (p.id !== e.pointerId) {
        endGesture();
        return;
      }
      const bins = Math.max(1, liveRef.current.buckets.length);
      const d = Math.round((e.clientX - p.x0) / (p.w / bins));
      if (d === p.d) {
        return;
      }
      p.d = d;
      setPanD(d);
      return;
    }
    const g = brushRef.current;
    if (!g || g.head) {
      return;
    }
    if (g.id !== e.pointerId) {
      endGesture();
      return;
    }
    const i = indexAt(e.clientX, surfaceRef.current);
    if (i === g.end) {
      return;
    }
    brushRef.current = { ...g, end: i };
    setBrush({ start: g.start, end: i });
  }

  function onPlotUp(e: { pointerId: number }): void {
    const p = panRef.current;
    if (p) {
      const next = p.d === 0 ? null : applyPan(p.d);
      const d = p.d;
      endGesture();
      if (next) {
        setPanLock({ d, fromMs: next.fromMs, toMs: next.toMs });
        liveRef.current.onWindow(iso(next.fromMs), iso(next.toMs));
      }
      return;
    }
    const g = brushRef.current;
    if (!g || g.head) {
      return;
    }
    if (g.id !== e.pointerId) {
      endGesture();
      return;
    }
    const start = g.start;
    const end = g.end;
    endGesture();
    commitBrush(start, end, false);
  }

  function onHeadDown(e: { currentTarget: HTMLDivElement; pointerId: number; clientX: number }): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = indexAt(e.clientX, surfaceRef.current);
    panRef.current = null;
    setPanning(false);
    brushRef.current = { start: i, end: i, id: e.pointerId, head: true };
    setBrush({ start: i, end: i });
    setHover(null);
    armHead(false);
    setShiftHeld(false);
  }

  function onHeadMove(e: { pointerId: number; clientX: number }): void {
    const g = brushRef.current;
    if (!g || !g.head) {
      return;
    }
    if (g.id !== e.pointerId) {
      endGesture();
      return;
    }
    const i = indexAt(e.clientX, surfaceRef.current);
    if (i === g.end) {
      return;
    }
    brushRef.current = { ...g, end: i };
    setBrush({ start: g.start, end: i });
  }

  function onHeadUp(e: { pointerId: number }): void {
    const g = brushRef.current;
    if (!g || !g.head) {
      return;
    }
    if (g.id !== e.pointerId) {
      endGesture();
      return;
    }
    const start = g.start;
    const end = g.end;
    endGesture();
    commitBrush(start, end, true);
  }

  useEffect(() => {
    function plotHasFocus(target: EventTarget | null): boolean {
      const plot = plotRef.current;
      if (!plot) {
        return false;
      }
      if (target instanceof Node && plot.contains(target)) {
        return true;
      }
      return plot.contains(document.activeElement);
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) {
        return;
      }
      if (!plotHasFocus(e.target)) {
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopImmediatePropagation();
        zoomAt(hoverRef.current, -1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        e.stopImmediatePropagation();
        zoomAt(hoverRef.current, 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const {
          buckets: nextBuckets,
          spanMs: span,
          stepMs: step,
          onWindow: setWin,
          retentionMs: keepMs,
        } =
          liveRef.current;
        const first = nextBuckets[0];
        if (!first) {
          return;
        }
        const fromMs = Date.parse(first.t);
        const toMs = fromMs + span;
        const n = e.key === "ArrowLeft" ? -1 : 1;
        const delta = e.shiftKey ? n * span : n * step;
        const next = panHistogramWindow(fromMs, toMs, delta, Date.now(), keepMs);
        if (!next) {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        setWin(iso(next.fromMs), iso(next.toMs));
      }
    }
    function onShift(e: KeyboardEvent) {
      if (e.key !== "Shift" || hoverRef.current == null) {
        return;
      }
      const on = e.type === "keydown";
      setShiftHeld(on);
      if (on) {
        armHead(false);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
    };
  }, []);

  useEffect(() => {
    let prev = 0;
    let acc = 0;
    let lastFire = 0;
    function onWheel(ev: WheelEvent) {
      const plotEl =
        ev.target instanceof Element ? ev.target.closest("[data-plot]") : null;
      if (!plotEl || !surfaceRef.current) {
        return;
      }
      ev.preventDefault();
      let d = ev.deltaY;
      if (ev.deltaMode === 1) {
        d *= 16;
      } else if (ev.deltaMode === 2) {
        d *= 100;
      }
      if (!d || Math.abs(ev.deltaX) > Math.abs(d)) {
        return;
      }
      const t = Date.now();
      const gap = t - prev;
      prev = t;
      const fire = (dir: 1 | -1) => {
        acc = 0;
        lastFire = t;
        zoomAt(indexAt(ev.clientX, surfaceRef.current), dir);
      };
      if (gap > 180) {
        fire(d > 0 ? 1 : -1);
        return;
      }
      acc += d;
      if (Math.abs(acc) < 120 || t - lastFire < 160) {
        return;
      }
      fire(acc > 0 ? 1 : -1);
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!panLock || !firstBucket) {
      return;
    }
    const arrived = Date.parse(firstBucket.t);
    if (Number.isFinite(arrived) && Math.abs(arrived - panLock.fromMs) < stepMs) {
      setPanLock(null);
    }
  }, [firstBucket, panLock, stepMs]);

  const lineLast = Math.max(1, buckets.length - 1);
  const xs = buckets.map((_, i) => (i / lineLast) * 1000);
  const linePoints = keys.map((key, si) => {
    const points = buckets
      .map((bucket, i) => {
        const y =
          PLOT_H -
          scaleCount(seriesValue(bucket, key, split), volumePeak, logScale) *
            PLOT_H;
        return `${xs[i]!.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return { key, color: seriesColor(key, split, si), points };
  });
  const areaPaths = (() => {
    const acc = buckets.map(() => 0);
    return keys.map((key, si) => {
      const bottoms = [...acc];
      const tops = buckets.map((bucket, i) => {
        const n = seriesValue(bucket, key, split);
        const add = stacked
          ? stackedSegmentPlotFrac(n, bucket.n, volumePeak, logScale)
          : scaleCount(n, volumePeak, logScale);
        const top = stacked ? (acc[i] ?? 0) + add : add;
        if (stacked) {
          acc[i] = top;
        }
        return top;
      });
      return {
        key,
        color: seriesColor(key, split, si),
        d: svgAreaPath(
          xs,
          tops.map((frac) => PLOT_H - frac * PLOT_H),
          bottoms.map((frac) => PLOT_H - frac * PLOT_H),
        ),
      };
    });
  })();
  const overlayLineSegs = overlayOn
    ? overlayLineSegments(xs, overlayValues, overlayPeak, logScale)
    : [];
  const overlayAreaSegs = overlayOn
    ? overlayAreaSegments(xs, overlayValues, overlayPeak, logScale)
    : [];
  const showVolume = !replaceY || !overlayOn;
  const overlayAsBars = overlayOn && replaceY && !asLine && !asArea;

  const brushStart = lo >= 0 ? buckets[lo] : undefined;
  const brushEnd = hi >= 0 ? buckets[hi] : undefined;
      const brushLabel =
    brush && lo !== hi && brushStart && brushEnd
      ? `${stamp(Date.parse(brushStart.t))}–${stamp(bucketEndMs(brushEnd, stepMs))} · ${abbrevCount(
          buckets.slice(lo, hi + 1).reduce((sum, bucket) => sum + bucket.n, 0),
        )}`
      : "";
  const overlayLabel = aggResult?.expr ?? metric ?? agg ?? "";
  const hoverOverlay =
    overlayOn && hover !== null
      ? { label: overlayLabel, v: overlayValues[hover] ?? null }
      : null;
  const headDrag = Boolean(brush && brushRef.current?.head);
  const sweepBins = headDrag && brush ? Math.abs(brush.end - brush.start) + 1 : 0;
  const knobBin = headDrag && brush ? brush.end : hover;
  const armed = headDrag || (headArmed && hover !== null && canDrill);
  const headShown = knobBin !== null && !sliding && !shiftHeld;
  const hbPct =
    knobBin === null || binCount === 0
      ? 0
      : ((knobBin + 0.5) / binCount) * 100;
  const liveStrip = knobBin !== null || sliding;
  const headLabel = headDrag
    ? formatSpanShort(sweepBins * stepMs)
    : armed
      ? formatSpanShort(drillMs)
      : "";
  const gCursor = panning ? "pan" : shiftHeld ? "brush" : "grab";
  const headCursor = headDrag ? "drag" : "idle";
  const hoverHint = histogramHoverHint({
    shiftHeld,
    headArmed,
    canDrill,
    drillLabel: formatSpanShort(drillMs),
  });
  const panChipText = previewWin
    ? `${stamp(previewWin.fromMs)} → ${stamp(previewWin.toMs)} · ${formatSpanShort(spanMs)}`
    : "";
  const knobBucket = knobBin !== null ? buckets[knobBin] : undefined;
  const headTitle =
    knobBucket === undefined
      ? undefined
      : canDrill
        ? `Click → ${formatSpanShort(drillMs)} around ${stamp(Date.parse(knobBucket.t))} · drag to sweep a span`
        : "Drag to sweep a span — this bar width is already the tightest window";
  const drillLeftPct =
    hover !== null && binCount > 0
      ? ((hover - (drillBins - 1) / 2) / binCount) * 100
      : 0;
  const drillWidthPct =
    binCount > 0 ? (drillBins / binCount) * 100 : 0;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card", className)}>
      <div
        className={cn(
          "flex items-center gap-x-3 gap-y-2 border-b border-white/[0.08] bg-background/45 px-3 py-2",
          compactToolbar ? "flex-nowrap overflow-x-auto" : "flex-wrap",
          lockChrome && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex h-[26px] shrink-0 items-center rounded-md border border-input p-0.5">
          {histogramSplits.map((key) => (
            <button
              key={key}
              type="button"
              className={pill(split === key)}
              onClick={() => onSplit(key)}
            >
              {key === "none" ? "None" : key[0]!.toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>
        <div className="h-4 w-px shrink-0 bg-border" />
        <div className="flex h-[26px] shrink-0 items-center rounded-md border border-input p-0.5">
          {histogramCharts.map((key) => (
            <button
              key={key}
              type="button"
              title={key[0]!.toUpperCase() + key.slice(1)}
              className={cn(pill(chart === key), "min-w-[26px] px-1.5")}
              onClick={() => onChart(key)}
            >
              <ChartGlyph kind={key} />
            </button>
          ))}
        </div>
        <div className="h-4 w-px shrink-0 bg-border" />
        <button
          type="button"
          className={cn(
            "h-[26px] shrink-0 rounded-md border border-input px-[9px] text-[12px]",
            logScale
              ? "border-ring bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={onToggleScale}
        >
          {logScale ? "Log" : "Linear"}
        </button>
        <HistogramIntervalChips
          spanMs={spanMs}
          override={interval}
          chart={chart}
          onCommit={onInterval}
        />
        <div className="h-4 w-px shrink-0 bg-border" />
        <label className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          Series
          <select
            className="h-[26px] max-w-[9rem] rounded-md border border-input bg-[#18181b] px-[5px] text-[11.5px] text-foreground"
            value={seriesSelectValue(seriesPick)}
            onChange={(e) => onSeries(applySeriesSelect(e.target.value, seriesPick))}
          >
            <option value="">Off</option>
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
        </label>
        {Object.entries(metricLabels).map(([key, value]) => (
          <button
            key={`${key}:${value}`}
            type="button"
            className="flex h-[22px] max-w-[11rem] shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px]"
            style={{ borderColor: AGG_COLOR, color: AGG_COLOR }}
            title="Drop this metric matcher"
            onClick={onClearMetricLabels}
          >
            <span className="truncate">
              {key}:{value}
            </span>
            <span aria-hidden>×</span>
          </button>
        ))}
        {seriesPick.kind === "key" ? (
          <select
            className="h-[26px] w-[4.75rem] rounded-md border border-input bg-[#18181b] px-[5px] text-[11.5px] text-foreground"
            value={seriesPick.op}
            aria-label="Series reducer"
            onChange={(e) => {
              const op = parseNumericPickerOp(e.target.value);
              if (!op) {
                return;
              }
              const next = aggFromOpSelect(op, seriesPick);
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
        {agg || metric ? (
          <div className="flex h-[26px] shrink-0 items-center rounded-md border border-input p-0.5">
            <button
              type="button"
              className={pill(!replaceY)}
              onClick={() => onReplaceY(false)}
            >
              Overlay
            </button>
            <button
              type="button"
              className={pill(replaceY)}
              onClick={() => onReplaceY(true)}
            >
              Replace
            </button>
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {updated}
          <WidgetExportMenu
            disabled={buckets.length === 0}
            onExport={(format) =>
              downloadWidgetSeries(histogramExport(buckets, aggResult), format)
            }
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-1.5 px-2.5 pt-2">
        <div
          className="flex w-8 shrink-0 flex-col justify-between py-[3px] text-right font-mono text-[10px] text-muted-foreground/70"
          style={{ marginTop: HEAD_H + HEAD_GAP }}
        >
          {yTicks.map((tick, i) => (
            <span key={`${tick}-${i}`}>
              {replaceY && overlayOn ? formatAggStat(tick) : abbrevCount(tick)}
            </span>
          ))}
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {loading && buckets.length === 0 ? (
            <div className="min-h-0 flex-1 animate-pulse" />
          ) : buckets.length === 0 ? (
            <div className="min-h-0 flex-1" />
          ) : (
            <div
              ref={surfaceRef}
              className="relative flex min-h-0 flex-1 select-none flex-col"
              onPointerMove={(e) => {
                if (brushRef.current || panRef.current) {
                  return;
                }
                onSurfaceMove(e);
              }}
              onPointerLeave={() => {
                if (brushRef.current || panRef.current) {
                  return;
                }
                setHover(null);
                armHead(false);
                setShiftHeld(false);
              }}
            >
              <div
                data-head="y"
                data-g={headCursor}
                className="relative touch-none"
                style={{ height: HEAD_H, marginBottom: HEAD_GAP }}
                onPointerDown={(e) => onHeadDown(e)}
                onPointerMove={(e) => onHeadMove(e)}
                onPointerUp={(e) => onHeadUp(e)}
                onPointerCancel={() => {
                  if (brushRef.current?.head) {
                    endGesture();
                  }
                }}
                onLostPointerCapture={(e) => onHeadUp(e)}
              >
                <div
                  className="absolute inset-x-0 top-0 rounded-sm"
                  style={{
                    height: HEAD_H,
                    background: `oklch(1 0 0 / ${liveStrip ? 5 : 2.5}%)`,
                    boxShadow: `inset 0 -1px 0 oklch(1 0 0 / ${liveStrip ? 12 : 6}%)`,
                  }}
                />
                {headShown ? (
                  <div
                    className="pointer-events-none absolute top-2.5 bottom-[-2px] w-px bg-white/25"
                    style={{ left: `${hbPct}%` }}
                  />
                ) : null}
                {headShown ? (
                  <div
                    className={cn(
                      "absolute z-[6] flex items-center justify-center font-mono",
                      armed
                        ? "top-0 h-3 w-[34px] -translate-x-1/2 rounded-sm bg-foreground text-[9.5px] tracking-tight text-background shadow-md"
                        : "top-0.5 h-2 w-4 -translate-x-1/2 rounded-[2px] bg-foreground/70",
                      canDrill || headDrag ? "cursor-pointer" : "cursor-default",
                    )}
                    style={{ left: `${hbPct}%` }}
                    title={headTitle}
                    onPointerEnter={() => {
                      if (hoverRef.current !== null && !headArmedRef.current) {
                        armHead(true);
                      }
                    }}
                    onPointerLeave={() => {
                      if (headArmedRef.current) {
                        armHead(false);
                      }
                    }}
                  >
                    {headLabel}
                  </div>
                ) : null}
                {panning ? (
                  <div className="absolute top-0 left-1/2 z-[6] flex h-3 -translate-x-1/2 items-center rounded-sm bg-accent px-1.5 font-mono text-[9.5px] whitespace-nowrap text-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0_/_18%)]">
                    {panChipText}
                  </div>
                ) : null}
              </div>
              <div
                ref={plotRef}
                data-plot="y"
                data-kbd="plot"
                tabIndex={0}
                data-g={gCursor}
                className="relative min-h-0 flex-1 overflow-hidden p-1 touch-none outline-none"
                onPointerDown={(e) => onPlotDown(e)}
                onPointerMove={(e) => onPlotMove(e)}
                onPointerUp={(e) => onPlotUp(e)}
                onPointerCancel={() => endGesture()}
                onLostPointerCapture={(e) => onPlotUp(e)}
              >
              <div
                className="pointer-events-none absolute inset-0"
                style={
                  sliding && binCount > 0
                    ? { transform: `translateX(${((slideD / binCount) * 100).toFixed(3)}%)` }
                    : undefined
                }
              >
              <div className="pointer-events-none absolute inset-1 flex flex-col justify-between">
                <div className="h-px bg-white/[0.07]" />
                <div className="h-px bg-white/[0.07]" />
                <div className="h-px bg-white/[0.07]" />
                <div className="h-px bg-white/[0.12]" />
              </div>
              {showVolume && (asLine || asArea) ? (
                <svg
                  viewBox={`0 0 1000 ${PLOT_H}`}
                  preserveAspectRatio="none"
                  className="pointer-events-none relative block h-full w-full"
                >
                  {asArea
                    ? areaPaths.map((area) => (
                        <path
                          key={area.key}
                          d={area.d}
                          fill={area.color}
                          fillOpacity={stacked ? 0.9 : 0.35}
                          stroke={area.color}
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))
                    : linePoints.map((line) => (
                        <polyline
                          key={line.key}
                          points={line.points}
                          fill="none"
                          stroke={line.color}
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                </svg>
              ) : null}
              {showVolume && !asLine && !asArea ? (
                <div className="relative flex h-full items-end gap-px">
                  {buckets.map((bucket, i) => {
                    const inDrag = brush !== null && i >= lo && i <= hi;
                    return (
                      <div
                        key={bucket.t}
                        className={cn(
                          "flex h-full min-w-0 flex-1 opacity-90",
                          stacked ? "flex-col-reverse" : "items-end gap-px",
                          inDrag ? "bg-primary/20" : "",
                        )}
                      >
                        {keys.map((key, si) => {
                          const n = seriesValue(bucket, key, split);
                          if (n <= 0) {
                            return stacked ? null : (
                              <div key={key} className="min-w-0 flex-1" />
                            );
                          }
                          const frac = stacked
                            ? stackedSegmentPlotFrac(n, bucket.n, volumePeak, logScale)
                            : scaleCount(n, volumePeak, logScale);
                          return (
                            <div
                              key={key}
                              className={stacked ? "w-full" : "min-w-0 flex-1"}
                              style={{
                                height: `max(1px, ${frac * 100}%)`,
                                background: seriesColor(key, split, si),
                                borderRadius: "1px 1px 0 0",
                              }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {overlayAsBars ? (
                <div className="pointer-events-none absolute inset-1 z-[2] flex items-end gap-px">
                  {overlayValues.map((v, i) => (
                    <div
                      key={buckets[i]?.t ?? i}
                      className="min-w-0 flex-1"
                      style={{
                        height: `max(0px, ${
                          overlayY(v, overlayPeak, logScale) === null
                            ? 0
                            : scaleCount(v ?? 0, overlayPeak, logScale) * 100
                        }%)`,
                        background: AGG_COLOR,
                        borderRadius: "1px 1px 0 0",
                        opacity: 0.9,
                      }}
                    />
                  ))}
                </div>
              ) : null}
              {overlayOn && !overlayAsBars ? (
                <svg
                  viewBox={`0 0 1000 ${PLOT_H}`}
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-1 z-[2]"
                >
                  {asArea || replaceY ? (
                    overlayAreaSegs.map((d) => (
                      <path
                        key={d}
                        d={d}
                        fill={AGG_COLOR}
                        fillOpacity={0.22}
                        stroke={AGG_COLOR}
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))
                  ) : (
                    overlayLineSegs.map((points) => (
                      <polyline
                        key={points}
                        points={points}
                        fill="none"
                        stroke={AGG_COLOR}
                        strokeWidth="1.75"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))
                  )}
                </svg>
              ) : null}
              </div>
              {armed && !headDrag && hover !== null ? (
                <div
                  className="pointer-events-none absolute inset-y-1 z-[2] border-x border-white/30 bg-white/[0.08]"
                  style={{
                    left: `${drillLeftPct.toFixed(3)}%`,
                    width: `${drillWidthPct.toFixed(3)}%`,
                  }}
                />
              ) : null}
              {brush && buckets.length > 0 ? (
                <div
                  className="pointer-events-none absolute inset-y-1 z-10 border-x border-white/45 bg-white/[0.09]"
                  style={{
                    left: `${(lo / buckets.length) * 100}%`,
                    width: `${((hi - lo + 1) / buckets.length) * 100}%`,
                  }}
                >
                  {brushLabel ? (
                    <div className="absolute top-0.5 left-0 rounded-sm border bg-card px-1 py-px font-mono text-[10px] whitespace-nowrap">
                      {brushLabel}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {anchorFrac !== null ? (
                <div
                  className="pointer-events-none absolute inset-y-1 z-[3] w-px bg-foreground/70"
                  style={{ left: `${(anchorFrac * 100).toFixed(2)}%` }}
                />
              ) : null}
              {hairlinePct !== null ? (
                <div
                  className="pointer-events-none absolute inset-y-1 z-10 w-px bg-white/32"
                  style={{ left: `${hairlinePct.toFixed(3)}%` }}
                />
              ) : null}
            </div>
            </div>
          )}
          {hoverBucket !== undefined &&
          hairlinePct !== null &&
          hover !== null &&
          !brush &&
          !sliding ? (
            <HistogramHover
              bucket={hoverBucket}
              rangeLabel={`${stamp(Date.parse(hoverBucket.t))}–${stamp(bucketEndMs(hoverBucket, stepMs))}`}
              keys={replaceY && overlayOn ? [] : keys}
              split={split}
              side={hoverSide}
              overlay={hoverOverlay}
              hint={hoverHint}
              left={
                hoverSide === "left"
                  ? `calc(${hairlinePct.toFixed(3)}% - ${HOVER_GAP_PX}px)`
                  : `calc(${hairlinePct.toFixed(3)}% + ${HOVER_GAP_PX}px)`
              }
            />
          ) : null}
        </div>
        {overlayOn && !replaceY ? (
          <div
            className="relative w-[34px] shrink-0 self-stretch font-mono text-[10px]"
            style={{ marginTop: HEAD_H + HEAD_GAP, color: AGG_COLOR }}
          >
            {overlayTicks.map((tick, i) => (
              <span
                key={`${tick}-${i}`}
                className="absolute left-0 whitespace-nowrap"
                style={{ top: `${[0, 33.334, 66.667, 100][i]}%`, transform: "translateY(-50%)" }}
              >
                {i === 3 ? "0" : formatAggStat(tick)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-1 flex shrink-0 justify-between pr-2.5 pl-[47px] font-mono text-[10px] text-muted-foreground/70">
        {axis.map((label, i) => (
          <span key={`${label}-${i}`}>{label}</span>
        ))}
      </div>
      {agg || metric || scanReason ? (
        <div className="mt-1 pr-2.5 pl-[47px] text-[11px] text-muted-foreground">
          {scanReason ? (
            <span>{scanReason}</span>
          ) : aggResult?.source === "refused" ? (
            <span>{aggResult.reason}</span>
          ) : (
            <span className="font-mono tabular-nums">
              {overlayLabel} {formatAggStat(aggResult?.stat)}
              {agg === "rate" ? "/s" : ""}
            </span>
          )}
        </div>
      ) : null}
      <div className="mt-2 flex shrink-0 flex-wrap items-center justify-start gap-x-3 gap-y-2.5 border-t border-white/[0.08] pr-2.5 pb-1.5 pl-[47px] pt-1.5">
        {showVolume
          ? keys.map((key, i) => (
              <span
                key={key}
                className="flex items-center gap-[5px] text-[11px] text-muted-foreground"
              >
                <span
                  className="size-[7px] rounded-sm"
                  style={{ background: seriesColor(key, split, i) }}
                />
                {key}
                <span className="font-mono text-muted-foreground/65">
                  {formatSeriesTotal(seriesTotal(buckets, key, split))}
                </span>
              </span>
            ))
          : null}
        {overlayOn ? (
          <span className="flex items-center gap-[5px] text-[11px] text-muted-foreground">
            <span
              className="size-[7px] rounded-sm"
              style={{ background: AGG_COLOR }}
            />
            {overlayLabel}
            <span className="font-mono text-muted-foreground/65">
              {formatAggStat(aggResult?.stat)}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ChartGlyph({ kind }: { kind: HistogramChartKind }) {
  switch (kind) {
    case "stacked":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M3 3v16a2 2 0 0 0 2 2h16" />
          <path d="M8 17v-3" />
          <path d="M8 14v-3" />
          <path d="M14 17v-4" />
          <path d="M14 13v-4" />
          <path d="M20 17v-2" />
          <path d="M20 15v-3" />
        </svg>
      );
    case "grouped":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M3 3v16a2 2 0 0 0 2 2h16" />
          <path d="M8 17V9" />
          <path d="M12 17v-5" />
          <path d="M16 17v-9" />
          <path d="M20 17v-4" />
        </svg>
      );
    case "line":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3v16a2 2 0 0 0 2 2h16" />
          <path d="m7 15 3-4 3 2 4-6" />
        </svg>
      );
    case "area":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3v16a2 2 0 0 0 2 2h16" />
          <path d="m7 16 4-6 3 3 5-7v10H7z" fill="currentColor" fillOpacity="0.35" />
        </svg>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
