import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ExtraPanel } from "@/components/extra-panel";
import { HistogramChart } from "@/components/histogram-chart";
import {
  HistogramMarksChip,
  type MarksOverlay,
} from "@/components/histogram-marks";
import { HbarHead, HbarWidget, hbarPaintedRows, type HbarCommand } from "@/components/hbar-widget";
import { StatHead, StatWidget, statSeriesFile } from "@/components/stat-widget";
import {
  usedCanvasFieldValues,
  usedCanvasSeriesValues,
} from "@/head-query";
import { TimeseriesSpark } from "@/components/timeseries-spark";
import { WidgetUpdated } from "@/components/widget-updated";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  copyWidgetSeries,
  downloadWidgetSeries,
  hbarExport,
  histogramExport,
  type WidgetSeriesFile,
} from "@/export-series";
import { cn } from "@/lib/utils";
import type { FacetValue, HistogramBucket, SearchAggResult } from "@/types";
import type {
  HistogramChartKind,
  HistogramIntervalId,
  HistogramSplit,
} from "../../query/histogram";
import { histogramRetentionMs } from "../histogram-zoom";
import {
  addHbar,
  addHistogram,
  addStat,
  attrSeriesKey,
  duplicateWidget,
  facetSeriesKey,
  gridRows,
  isPinnedHistogram,
  maxWidgetH,
  maxWidgets,
  minHbarH,
  minStatH,
  minStatW,
  minTimeseriesH,
  minTimeseriesW,
  minWidgetW,
  moveWidget,
  patchWidget,
  removeWidget,
  resizeWidget,
  seriesQueryKey,
  widgetGapPx,
  widgetGridCols,
  widgetRowPx,
  widgetSeriesQuery,
  type WidgetDef,
} from "../../shared/widgets";

export type SeriesData = {
  histogram: HistogramBucket[];
  agg: SearchAggResult | null;
  total: number;
  values?: FacetValue[];
  fetchedAt?: number;
};

type Props = {
  widgets: WidgetDef[];
  logs: boolean;
  onWidgets: (next: WidgetDef[]) => void;
  onLogs: (on: boolean) => void;
  series: Record<string, SeriesData>;
  loading: boolean;
  live: boolean;
  numericKeys: string[];
  metricNames: string[];
  attrKeys: string[];
  skipAttrKeys?: string[];
  spanMs: number;
  interval: HistogramIntervalId | null;
  onInterval: (next: HistogramIntervalId | null) => void;
  onWindow: (fromIso: string, toIso: string) => void;
  onCommand?: (command: HbarCommand, field: string, value: string) => void;
  anchorTs?: string | null;
  locked?: boolean;
  retentionMs?: number;
  scanReason?: string | null;
  marks?: MarksOverlay | null;
  focusMarkId?: string | null;
  onFocusMark?: (id: string | null) => void;
};

type Drag = {
  id: string;
  mode: "move" | "resize";
  pointerId: number;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  x0: number;
  y0: number;
  w0: number;
  h0: number;
};

type Cell = { x: number; y: number; w: number; h: number };

const capTitle = "Six panels is the cap — remove one to add another";

function lookupKey(widget: WidgetDef): string {
  if (widget.kind === "hbar") {
    return widget.attr ? attrSeriesKey(widget.attr) : facetSeriesKey(widget.split);
  }
  return seriesQueryKey(widgetSeriesQuery(widget));
}

function minSize(widget: WidgetDef): { w: number; h: number } {
  switch (widget.kind) {
    case "stat":
      return { w: minStatW, h: minStatH };
    case "hbar":
      return { w: minWidgetW, h: minHbarH };
    case "timeseries":
      return { w: minTimeseriesW, h: minTimeseriesH };
    default: {
      const _exhaustive: never = widget.kind;
      return _exhaustive;
    }
  }
}

function ResizeHandle({
  active,
  label,
  onPointerDown,
}: {
  active: boolean;
  label: string;
  onPointerDown: (e: PointerEvent) => void;
}) {
  return (
    <button
      type="button"
      data-widget-handle="resize"
      title={label}
      aria-label={label}
      className={cn(
        "absolute right-[3px] bottom-[3px] z-10 flex size-[18px] cursor-se-resize items-center justify-center rounded p-0 text-muted-foreground/70",
        active ? "bg-ring/45 text-foreground" : "bg-transparent",
      )}
      onPointerDown={onPointerDown}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M11 4 4 11" />
        <path d="M11 8.5 8.5 11" />
      </svg>
    </button>
  );
}

export function WidgetCanvas({
  widgets,
  logs,
  onWidgets,
  onLogs,
  series,
  loading,
  live,
  numericKeys,
  metricNames,
  attrKeys,
  skipAttrKeys = [],
  spanMs,
  interval,
  onInterval,
  onWindow,
  onCommand,
  anchorTs = null,
  locked = false,
  retentionMs = histogramRetentionMs,
  scanReason = null,
  marks = null,
  focusMarkId = null,
  onFocusMark,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const widgetsRef = useRef(widgets);
  const dragRef = useRef<Drag | null>(null);
  const ghostRef = useRef<Cell | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<Cell | null>(null);
  const [lift, setLift] = useState<{ dx: number; dy: number } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  widgetsRef.current = widgets;
  dragRef.current = drag;
  ghostRef.current = ghost;

  useEffect(() => {
    if (!live) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!fresh) {
      return;
    }
    const id = window.setTimeout(
      () => setFresh((cur) => (cur === fresh ? null : cur)),
      1500,
    );
    return () => window.clearTimeout(id);
  }, [fresh]);

  useEffect(() => {
    if (!armed && !drag) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      if (dragRef.current) {
        finishDrag(false);
        return;
      }
      setArmed(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armed, drag]);

  useEffect(() => {
    if (!drag) {
      return;
    }
    function onMove(e: globalThis.PointerEvent) {
      onPointerMove(e);
    }
    function onUp() {
      finishDrag(true);
    }
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [drag]);

  const atCap = widgets.length >= maxWidgets;
  const extras = widgets.length > 1;
  const displayWidgets = widgets.map((widget) => {
    if (drag?.id === widget.id && drag.mode === "resize" && ghost) {
      return { ...widget, w: ghost.w, h: ghost.h };
    }
    return widget;
  });
  const rows = gridRows(displayWidgets);
  const dashGhost =
    drag && ghost
      ? drag.mode === "resize"
        ? { x: drag.x0, y: drag.y0, w: drag.w0, h: drag.h0 }
        : ghost
      : null;

  function lookup(widget: WidgetDef): SeriesData {
    return (
      series[lookupKey(widget)] ?? {
        histogram: [],
        agg: null,
        total: 0,
        values: [],
      }
    );
  }

  function reveal(id: string, bottomRow: number) {
    setFresh(id);
    requestAnimationFrame(() => {
      const grid = gridRef.current;
      if (!grid) {
        return;
      }
      let sc: HTMLElement | null = grid.parentElement;
      while (sc) {
        const overflowY = getComputedStyle(sc).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          break;
        }
        sc = sc.parentElement;
      }
      if (!sc) {
        return;
      }
      const gr = grid.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      const gridTop = gr.top - sr.top + sc.scrollTop;
      const bottom = gridTop + bottomRow * (widgetRowPx + widgetGapPx) - widgetGapPx;
      if (bottom > sc.scrollTop + sc.clientHeight) {
        sc.scrollTop = bottom - sc.clientHeight + 12;
      }
    });
  }

  function onAdd(kind: "timeseries" | "stat" | "hbar") {
    if (atCap) {
      return;
    }
    const next =
      kind === "timeseries"
        ? addHistogram(widgets)
        : kind === "stat"
          ? addStat(widgets)
          : addHbar(widgets);
    const added = next.find((item) => !widgets.some((w) => w.id === item.id));
    onWidgets(next);
    if (added) {
      reveal(added.id, added.y + added.h);
    }
  }

  function onDuplicate(id: string) {
    const next = duplicateWidget(widgets, id);
    const added = next.find((item) => !widgets.some((w) => w.id === item.id));
    onWidgets(next);
    if (added) {
      setArmed(null);
      reveal(added.id, added.y + added.h);
    }
  }

  function beginDrag(e: PointerEvent, widget: WidgetDef, mode: "move" | "resize") {
    if (e.button !== 0) {
      return;
    }
    if (mode === "move" && isPinnedHistogram(widget)) {
      return;
    }
    if (mode === "move" && (e.target as HTMLElement).closest("button, select, input, a")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // jsdom
    }
    const rect = grid.getBoundingClientRect();
    const colW = rect.width / widgetGridCols;
    const rowH = widgetRowPx + widgetGapPx;
    const next: Drag = {
      id: widget.id,
      mode,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: Math.floor((e.clientX - rect.left) / colW) - widget.x,
      oy: Math.floor((e.clientY - rect.top) / rowH) - widget.y,
      x0: widget.x,
      y0: widget.y,
      w0: widget.w,
      h0: widget.h,
    };
    setArmed(null);
    setDrag(next);
    setGhost({ x: widget.x, y: widget.y, w: widget.w, h: widget.h });
    setLift({ dx: 0, dy: 0 });
  }

  function onPointerMove(e: { clientX: number; clientY: number }) {
    const current = dragRef.current;
    const grid = gridRef.current;
    if (!current || !grid) {
      return;
    }
    const rect = grid.getBoundingClientRect();
    const colW = rect.width / widgetGridCols;
    const rowH = widgetRowPx + widgetGapPx;
    if (current.mode === "move") {
      const x = Math.max(
        0,
        Math.min(
          widgetGridCols - current.w0,
          Math.floor((e.clientX - rect.left) / colW) - current.ox,
        ),
      );
      const y = Math.max(0, Math.floor((e.clientY - rect.top) / rowH) - current.oy);
      setLift({ dx: e.clientX - current.sx, dy: e.clientY - current.sy });
      const prev = ghostRef.current;
      if (!prev || prev.x !== x || prev.y !== y) {
        setGhost({ x, y, w: current.w0, h: current.h0 });
      }
      return;
    }
    const widget = widgetsRef.current.find((item) => item.id === current.id);
    const min = widget ? minSize(widget) : { w: minTimeseriesW, h: minTimeseriesH };
    const w = Math.max(
      min.w,
      Math.min(widgetGridCols - current.x0, current.w0 + Math.round((e.clientX - current.sx) / colW)),
    );
    const h = Math.max(
      min.h,
      Math.min(maxWidgetH, current.h0 + Math.round((e.clientY - current.sy) / rowH)),
    );
    const prev = ghostRef.current;
    if (!prev || prev.w !== w || prev.h !== h) {
      setGhost({ x: current.x0, y: current.y0, w, h });
    }
  }

  function finishDrag(commit: boolean) {
    const current = dragRef.current;
    const g = ghostRef.current;
    if (!current) {
      return;
    }
    dragRef.current = null;
    ghostRef.current = null;
    const grid = gridRef.current;
    if (grid) {
      try {
        grid.releasePointerCapture(current.pointerId);
      } catch {
        // already released
      }
    }
    setDrag(null);
    setGhost(null);
    setLift(null);
    if (!commit || !g) {
      return;
    }
    if (g.x === current.x0 && g.y === current.y0 && g.w === current.w0 && g.h === current.h0) {
      return;
    }
    const list = widgetsRef.current;
    if (current.mode === "move") {
      onWidgets(moveWidget(list, current.id, g.x, g.y));
      return;
    }
    onWidgets(resizeWidget(list, current.id, g.w, g.h));
  }

  function extraBody(widget: WidgetDef, data: SeriesData, updated: ReactNode) {
    switch (widget.kind) {
      case "timeseries":
        return (
          <TimeseriesSpark
            buckets={data.histogram}
            split={widget.split}
            agg={widget.agg}
            metric={widget.metric}
            aggResult={data.agg}
            numericKeys={numericKeys}
            metricNames={metricNames}
            loading={loading}
            onSplit={(next) => onWidgets(patchWidget(widgets, widget.id, { split: next }))}
            onAgg={(next) =>
              onWidgets(
                patchWidget(widgets, widget.id, {
                  agg: next,
                  metric: next ? null : widget.metric,
                  metricLabels: next ? {} : widget.metricLabels,
                }),
              )
            }
            onSeries={(next) =>
              onWidgets(
                patchWidget(widgets, widget.id, {
                  agg: next.agg,
                  metric: next.metric,
                  metricLabels: {},
                }),
              )
            }
            updated={updated}
          />
        );
      case "stat":
        return (
          <StatWidget
            total={data.total}
            agg={widget.agg}
            metric={widget.metric}
            aggResult={data.agg}
            loading={loading}
            updated={updated}
          />
        );
      case "hbar":
        return (
          <HbarWidget
            split={widget.split}
            attr={widget.attr}
            values={data.values ?? []}
            total={data.total}
            loading={loading}
            n={widget.n}
            pct={widget.pct}
            updated={updated}
            onCommand={onCommand}
          />
        );
      default: {
        const _exhaustive: never = widget.kind;
        return _exhaustive;
      }
    }
  }

  function extraIdentity(widget: WidgetDef): ReactNode {
    switch (widget.kind) {
      case "stat":
        return (
          <StatHead
            agg={widget.agg}
            metric={widget.metric}
            numericKeys={numericKeys}
            metricNames={metricNames}
            usedSeries={usedCanvasSeriesValues(widgets, widget.id)}
            onAgg={(next) =>
              onWidgets(
                patchWidget(widgets, widget.id, {
                  agg: next ?? "count",
                  metric: null,
                  metricLabels: {},
                }),
              )
            }
            onSeries={(next) =>
              onWidgets(
                patchWidget(widgets, widget.id, {
                  agg: next.metric ? null : (next.agg ?? "count"),
                  metric: next.metric,
                  metricLabels: {},
                }),
              )
            }
          />
        );
      case "hbar":
        return (
          <HbarHead
            split={widget.split}
            attr={widget.attr}
            n={widget.n}
            attrKeys={attrKeys}
            skipAttrKeys={skipAttrKeys}
            usedFields={usedCanvasFieldValues(widgets, widget.id)}
            onSplit={(next: HistogramSplit) =>
              onWidgets(patchWidget(widgets, widget.id, { split: next, attr: null }))
            }
            onAttr={(next) => onWidgets(patchWidget(widgets, widget.id, { attr: next }))}
            onN={(next) => onWidgets(patchWidget(widgets, widget.id, { n: next }))}
          />
        );
      case "timeseries":
        return null;
      default: {
        const _exhaustive: never = widget.kind;
        return _exhaustive;
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={cn(
          "mb-2 flex items-center gap-2",
          locked && "pointer-events-none opacity-50",
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-[26px] gap-1.5 px-2.5 text-[11.5px]"
              disabled={atCap}
              title={atCap ? capTitle : `Add a panel · ${widgets.length} of ${maxWidgets} used`}
            >
              <Plus className="size-3" />
              Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[214px]">
            {(
              [
                ["timeseries", "Histogram", "split · series"],
                ["stat", "Stat", "one number"],
                ["hbar", "Top-N bars", "shares of window"],
              ] as const
            ).map(([kind, label, hint]) => (
              <DropdownMenuItem
                key={kind}
                className="h-7 gap-2.5 text-[12.5px]"
                onSelect={() => onAdd(kind)}
              >
                <span className="flex-1">{label}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">{hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex h-[26px] items-center rounded-md border border-input p-0.5">
          <button
            type="button"
            className={cn(
              "h-[22px] rounded-sm px-2 text-[11.5px]",
              logs ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={logs}
            title="Show the event table under the canvas"
            onClick={() => onLogs(true)}
          >
            Logs on
          </button>
          <button
            type="button"
            className={cn(
              "h-[22px] rounded-sm px-2 text-[11.5px]",
              !logs ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={!logs}
            title="Charts only — the table stops loading pages"
            onClick={() => onLogs(false)}
          >
            Logs off
          </button>
        </div>
        {marks ? (
          <HistogramMarksChip overlay={marks} placement="bar" />
        ) : null}
        {extras ? (
          <span
            className={cn(
              "min-w-0 truncate font-mono text-[11px]",
              atCap ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {widgets.length}/{maxWidgets} panels
          </span>
        ) : null}
      </div>
      <div
        ref={gridRef}
        data-canvas="y"
        className={cn("relative grid", locked && "pointer-events-none")}
        style={{
          gridTemplateColumns: `repeat(${widgetGridCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, ${widgetRowPx}px)`,
          gap: widgetGapPx,
          touchAction: "none",
          cursor: drag?.mode === "resize" ? "se-resize" : undefined,
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => finishDrag(true)}
        onPointerCancel={() => finishDrag(true)}
      >
        {dashGhost ? (
          <div
            className="z-0 rounded-lg border border-dashed border-ring bg-ring/10"
            style={{
              gridColumn: `${dashGhost.x + 1} / span ${dashGhost.w}`,
              gridRow: `${dashGhost.y + 1} / span ${dashGhost.h}`,
            }}
          />
        ) : null}
        {displayWidgets.map((widget) => {
          const data = lookup(widget);
          const updated: ReactNode = live ? (
            <WidgetUpdated fetchedAt={data.fetchedAt} now={now} />
          ) : null;
          const pinned = isPinnedHistogram(widget);
          const dragging = drag?.id === widget.id;
          const sizing = dragging && drag?.mode === "resize";
          const moving = dragging && drag?.mode === "move";
          const isFresh = fresh === widget.id;
          const hbarRowsPainted = widget.kind === "hbar"
            ? hbarPaintedRows(widget.split, widget.attr, data.values ?? [], data.total, widget.n)
            : [];
          return (
            <div
              key={widget.id}
              className={cn(
                "relative min-h-0 min-w-0",
                "transition-[box-shadow] duration-500",
                isFresh ? "rounded-lg shadow-[0_0_0_3px_oklch(0.552_0.016_285.938_/_30%)]" : "",
              )}
              style={{
                zIndex: dragging ? 30 : pinned ? 2 : 1,
                gridColumn: `${widget.x + 1} / span ${widget.w}`,
                gridRow: `${widget.y + 1} / span ${widget.h}`,
                transform:
                  moving && lift
                    ? `translate(${Math.round(lift.dx)}px, ${Math.round(lift.dy)}px)`
                    : undefined,
                pointerEvents: moving ? "none" : undefined,
                opacity: moving ? 0.96 : undefined,
              }}
            >
              {pinned ? (
                <HistogramChart
                  buckets={data.histogram}
                  loading={loading}
                  live={live}
                  split={widget.split}
                  chart={widget.chart}
                  logScale={widget.logScale}
                  onSplit={(next) =>
                    onWidgets(patchWidget(widgets, widget.id, { split: next }))
                  }
                  onChart={(next: HistogramChartKind) =>
                    onWidgets(patchWidget(widgets, widget.id, { chart: next }))
                  }
                  onToggleScale={() =>
                    onWidgets(
                      patchWidget(widgets, widget.id, { logScale: !widget.logScale }),
                    )
                  }
                  onWindow={onWindow}
                  spanMs={spanMs}
                  interval={interval}
                  onInterval={onInterval}
                  anchorTs={anchorTs}
                  agg={widget.agg}
                  onAgg={(next) =>
                    onWidgets(
                      patchWidget(widgets, widget.id, {
                        agg: next,
                        metric: next ? null : widget.metric,
                        metricLabels: next ? {} : widget.metricLabels,
                      }),
                    )
                  }
                  metric={widget.metric}
                  metricLabels={widget.metricLabels}
                  onClearMetricLabels={() =>
                    onWidgets(patchWidget(widgets, widget.id, { metricLabels: {} }))
                  }
                  onSeries={(next) =>
                    onWidgets(
                      patchWidget(widgets, widget.id, {
                        agg: next.agg,
                        metric: next.metric,
                        metricLabels: {},
                      }),
                    )
                  }
                  replaceY={widget.replaceY}
                  onReplaceY={(on) =>
                    onWidgets(patchWidget(widgets, widget.id, { replaceY: on }))
                  }
                  aggResult={data.agg}
                  numericKeys={numericKeys}
                  metricNames={metricNames}
                  updated={updated}
                  compactToolbar={widget.w < 8}
                  lockChrome={locked}
                  retentionMs={retentionMs}
                  scanReason={scanReason}
                  marks={locked ? undefined : marks}
                  focusMarkId={focusMarkId}
                  onFocusMark={onFocusMark}
                  className="h-full"
                />
              ) : (
                <ExtraPanel
                  widget={widget}
                  armed={armed === widget.id}
                  atCap={atCap}
                  moving={Boolean(moving)}
                  highlight={isFresh}
                  lockChrome={locked}
                  identity={extraIdentity(widget)}
                  pct={widget.pct}
                  onPct={
                    widget.kind === "hbar"
                      ? (on) => onWidgets(patchWidget(widgets, widget.id, { pct: on }))
                      : undefined
                  }
                  exportDisabled={
                    widget.kind === "hbar"
                      ? hbarRowsPainted.length === 0
                      : widget.kind === "timeseries"
                        ? data.histogram.length === 0
                        : false
                  }
                  onArm={() => setArmed(widget.id)}
                  onDisarm={() => setArmed(null)}
                  onRemove={() => {
                    setArmed(null);
                    onWidgets(removeWidget(widgets, widget.id));
                  }}
                  onDuplicate={() => onDuplicate(widget.id)}
                  onCopy={(format) => {
                    void copyWidgetSeries(
                      extraSeriesFile(widget, data, hbarRowsPainted),
                      format,
                    ).then((ok) => {
                      if (ok) {
                        toast.success(`${format.toUpperCase()} copied`);
                        return;
                      }
                      toast.error("Copy failed");
                    });
                  }}
                  onExport={(format) => {
                    downloadWidgetSeries(
                      extraSeriesFile(widget, data, hbarRowsPainted),
                      format,
                    );
                  }}
                  onMovePointerDown={(e) => beginDrag(e, widget, "move")}
                >
                  {extraBody(widget, data, updated)}
                </ExtraPanel>
              )}
              {locked ? null : (
              <ResizeHandle
                active={Boolean(sizing)}
                label={pinned ? "Resize histogram" : "Resize widget"}
                onPointerDown={(e) => beginDrag(e, widget, "resize")}
              />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function extraSeriesFile(
  widget: WidgetDef,
  data: SeriesData,
  hbarRows: Array<{ key: string; n: number }>,
): WidgetSeriesFile {
  if (widget.kind === "stat") {
    return statSeriesFile(data.total, widget.agg, widget.metric, data.agg);
  }
  if (widget.kind === "hbar") {
    return hbarExport(hbarRows);
  }
  return histogramExport(data.histogram, data.agg);
}
