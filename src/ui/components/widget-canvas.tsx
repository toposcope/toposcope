import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ExtraPanel } from "@/components/extra-panel";
import { AddToBoardButton, type BoardChoice } from "@/components/add-to-board";
import { SharePanelsDialog } from "@/components/share-panels-dialog";
import { defaultHbarN } from "../../shared/widgets";
import { panelRange } from "../share-from-panel";
import { HistogramChart } from "@/components/histogram-chart";
import {
  HistogramMarksChip,
  type MarksOverlay,
} from "@/components/histogram-marks";
import { type CompareFoldHunt } from "@/components/compare-fold";
import { compareFoldExtraRows } from "@/compare-fold";
import { HbarHead, HbarWidget, hbarPaintedRows, type HbarCommand } from "@/components/hbar-widget";
import { StatHead, StatWidget, statSeriesFile } from "@/components/stat-widget";
import {
  usedCanvasFieldValues,
  usedCanvasSeriesValues,
} from "@/head-query";
import { bucketStepLabel, TimeseriesSpark } from "@/components/timeseries-spark";
import { MetricChartPicker, metricStackable } from "@/components/metric-spark";
import { TopViewPicker } from "@/components/hbar-widget";
import { printUnit, unitsDifferWords } from "../metric-unit";
import { metricPanelHeld, useHeldView } from "../held-context";
import { seriesPickFromWidget } from "../agg-picker";
import { metricReading, metricView } from "../series-list";
import { FitName } from "@/components/fit-name";
import { PanelNote, PanelNoteField, PanelTells, PanelTitle, PanelTitleField } from "@/components/panel-words";
import { PanelEditor } from "@/components/panel-editor";
import { panelLines, panelNote, type PanelLines } from "../panel-lines";
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
import { GridHandles, GridSizeChip, useGridGestures, useGridSlide } from "../grid-gestures";
import { HoverTimeProvider } from "../hover-time";
import { gravity, gridEdges } from "../../shared/grid-gravity";
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
  widgetMinSize,
  widgetTitle,
  addStat,
  attrSeriesKey,
  clampWidget,
  duplicateWidget,
  facetSeriesKey,
  gridRows,
  isPinnedHistogram,
  maxWidgetH,
  maxWidgets,
  patchWidget,
  removeWidget,
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
  /** What matched and when (33d): drawn at the top of the pinned plot. */
  head?: ReactNode;
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
  /** The hunt's `q`: what a log panel shares (#236). */
  query?: string;
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
  compareFold?: CompareFoldHunt | null;
  /** Add to board (#410, 39e): on each panel's ⋯ menu and in the pinned plot's head. */
  addToBoard?: { boards: BoardChoice[]; onPick: (widget: WidgetDef, boardId: string | null) => void } | null;
};

const capTitle = "Six panels is the cap — remove one to add another";

function lookupKey(widget: WidgetDef): string {
  if (widget.kind === "hbar") {
    return widget.attr ? attrSeriesKey(widget.attr) : facetSeriesKey(widget.split);
  }
  return seriesQueryKey(widgetSeriesQuery(widget));
}


export function WidgetCanvas({
  head,
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
  query,
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
  compareFold = null,
  addToBoard = null,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const widgetsRef = useRef(widgets);
  const [now, setNow] = useState(() => Date.now());
  const [compareLines, setCompareLines] = useState(1);
  // Share… (#236): the panels ticked when the dialog opens; null while it is shut.
  const [sharing, setSharing] = useState<string[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  /** The panel being edited (#169, 17c–17d): its title and note are fields, its lines open under it. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const held = useHeldView();
  const [fresh, setFresh] = useState<string | null>(null);
  widgetsRef.current = widgets;

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
    if (!armed) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      setArmed(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armed]);

  const atCap = widgets.length >= maxWidgets;
  const extras = widgets.length > 1;
  // Sheet 44, E: the pinned plot keeps its corner; every other panel floats up, so a saved hole closes.
  const anchored = new Set(widgets.filter(isPinnedHistogram).map((w) => w.id));
  const settled = gravity(widgets, widgets.filter(isPinnedHistogram), anchored);
  const pinnedNow = settled.find(isPinnedHistogram);
  const extraRows = compareFold && !locked ? compareFoldExtraRows(compareLines) : 0;
  const grid = useGridGestures({
    gridRef,
    cells: settled,
    rowPx: widgetRowPx,
    gapPx: widgetGapPx,
    limits: { min: widgetMinSize, maxH: maxWidgetH, anchored },
    // Rows under the pinned plot sit lower by the Compare fold's rows.
    layoutRow: (row) => (pinnedNow && row >= pinnedNow.y + pinnedNow.h + extraRows ? row - extraRows : row),
    onCommit: (next) => {
      setArmed(null);
      onWidgets(next.map((w) => clampWidget(w)));
    },
    disabled: locked,
  });
  const displayWidgets = grid.cells;
  useGridSlide(gridRef, displayWidgets.map((w) => `${w.id}:${w.x},${w.y},${w.w},${w.h}`).join(" "), grid.moving);
  const pinnedWidget = displayWidgets.find(isPinnedHistogram);
  /** Every metric a title could be read as: the canvas's own and the window's busiest. */
  const canvasMetricNames = [
    ...new Set([...widgets.flatMap((widget) => (widget.metric ? [widget.metric] : [])), ...metricNames]),
  ];
  const rows = gridRows(displayWidgets) + extraRows + (grid.dragging ? 2 : 0);
  function canvasY(y: number): number {
    return pinnedWidget && y >= pinnedWidget.y + pinnedWidget.h ? y + extraRows : y;
  }
  const dashGhost = grid.ghost;

  /** Each named line's metric, labels and sender's words, for the legend's card (17f). */
  function legendInfo(lines: PanelLines | null): Record<string, { metric: string; labels: string; description: string | null }> | undefined {
    if (!lines?.legend.length) {
      return undefined;
    }
    return Object.fromEntries(lines.legend.map(({ key, ...info }) => [key, info]));
  }

  /** A metric panel's lines put together (#169): merged metrics and named values, drawn as a split is. */
  function linesOf(widget: WidgetDef): PanelLines | null {
    if (widget.kind !== "timeseries" || !widget.metric) {
      return null;
    }
    return panelLines(widget, (query) => series[seriesQueryKey(query)]?.agg ?? null);
  }

  /** The panel's editor (#169): its lines, names, title and note; a refused metric goes on a panel of its own. */
  function editorFor(widget: WidgetDef): ReactNode {
    if (widget.kind !== "timeseries" || !widget.metric || locked) {
      return null;
    }
    const own = series[seriesQueryKey(widgetSeriesQuery(widget))]?.agg ?? null;
    return (
      <PanelEditor
        widget={widget}
        unit={own?.unit ?? null}
        splitValues={(own?.splits ?? []).map((line) => line.key)}
        editing={editingId === widget.id}
        onEditing={(on) => setEditingId(on ? widget.id : null)}
        onPatch={(patch) => onWidgets(patchWidget(widgets, widget.id, patch))}
        onNewPanel={
          atCap
            ? undefined
            : (metric) => {
                const placed = addHistogram(widgets);
                const added = placed.find((w) => !widgets.some((old) => old.id === w.id));
                onWidgets(added ? patchWidget(placed, added.id, { metric, metricLabels: {}, agg: null, replaceY: true }) : placed);
              }
        }
      />
    );
  }

  /** The title a panel makes for itself: the title field's placeholder (17d). */
  function madeTitleOf(widget: WidgetDef): string {
    const more = widget.lines?.length ? ` + ${widget.lines.length}` : "";
    const pick = widget.metric ? seriesPickFromWidget(null, widget.metric) : null;
    if (pick?.kind !== "metric") {
      return widgetTitle({ ...widget, title: undefined }) + more;
    }
    const view = metricView(pick, null, series[seriesQueryKey(widgetSeriesQuery(widget))]?.agg ?? null);
    return `${metricReading(view.kind, "", true, view.reading)} · ${view.name}${more}`;
  }

  function lookup(widget: WidgetDef): SeriesData {
    const base = series[lookupKey(widget)] ?? {
      histogram: [],
      agg: null,
      total: 0,
      values: [],
    };
    const lines = linesOf(widget);
    return lines ? { ...base, agg: lines.agg } : base;
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

  function extraBody(widget: WidgetDef, data: SeriesData, updated: ReactNode) {
    switch (widget.kind) {
      case "timeseries": {
        const lines = linesOf(widget);
        const note = lines ? panelNote(widget, lines) : null;
        // #331: a source short inside the window, and points sent in more than one unit, said on the panel.
        const metricShort = widget.metric ? metricPanelHeld(held, data.agg, widget.metricLabels) : null;
        // A deploy a unit changed around is named in the line and drawn on the plot (33e).
        const panelMarks = marks ? marks.marks.filter((mark) => !marks.offKinds.includes(mark.kind)) : undefined;
        const unitsNote = widget.metric ? unitsDifferWords(data.agg?.units_differ, panelMarks) : null;
        const tells = metricShort || unitsNote ? <PanelTells held={metricShort?.pill ?? null} units={unitsNote} /> : null;
        const spark = (
          <TimeseriesSpark
            // A stack only where parts add up (#237): a saved Stacked on a gauge paints as bars.
            metricChart={
              widget.metricChart === "stacked" && metricStackable(data.agg, widget.metricSplit ?? null) !== true
                ? "bars"
                : (widget.metricChart ?? "line")
            }
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
            onMetric={(next) => onWidgets(patchWidget(widgets, widget.id, { metric: next }))}
            metricSplit={widget.metricSplit ?? null}
            onMetricSplit={(next) => onWidgets(patchWidget(widgets, widget.id, { metricSplit: next }))}
            live={live}
            updated={updated}
            editor={editorFor(widget)}
            namedLines={Boolean(lines?.legend.length)}
            held={metricShort}
            marks={panelMarks}
            timeId={widget.id}
          />
        );
        const editing = editingId === widget.id;
        if (!editing && !note && !lines?.leftOff.length && !tells) {
          return spark;
        }
        return (
          <div className="flex min-h-0 flex-1 flex-col">
            {editing ? (
              <PanelNoteField widget={widget} onNote={(next) => onWidgets(patchWidget(widgets, widget.id, { note: next }))} />
            ) : (
              <PanelNote note={note} leftOff={lines?.leftOff ?? []} />
            )}
            {tells}
            {spark}
          </div>
        );
      }
      case "stat":
        return (
          <StatWidget
            total={data.total}
            agg={widget.agg}
            metric={widget.metric}
            metricLabels={widget.metricLabels}
            aggResult={data.agg}
            loading={loading}
            updated={updated}
          />
        );
      case "hbar":
        return (
          <HbarWidget
            view={widget.topView === "donut" ? "donut" : "bars"}
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

  function extraIdentity(widget: WidgetDef, data: SeriesData): ReactNode {
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
            onMetric={(next) => onWidgets(patchWidget(widgets, widget.id, { metric: next }))}
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
      case "timeseries": {
        if (!widget.metric) {
          return null;
        }
        // A metric's card is titled by how it is read, first, then its name cut in the middle.
        const pick = seriesPickFromWidget(null, widget.metric);
        if (pick.kind !== "metric") {
          return null;
        }
        const view = metricView(pick, null, data.agg);
        const step = bucketStepLabel(data.histogram);
        const unit = printUnit(data.agg?.unit);
        const labels = Object.entries(widget.metricLabels);
        const more = widget.lines?.length ?? 0;
        if (editingId === widget.id) {
          return (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <PanelTitleField
                compact
                widget={widget}
                madeTitle={madeTitleOf(widget)}
                onTitle={(next) => onWidgets(patchWidget(widgets, widget.id, { title: next }))}
              />
              {unit ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{unit}</span> : null}
            </span>
          );
        }
        if (widget.title) {
          // #169: the title it was given; what the lines are is one hover away, and in its legend.
          return (
            <span
              className="flex min-w-0 items-baseline gap-2 py-[3px]"
              title={[widget.metric, ...(widget.lines ?? []).map((line) => line.metric)].join("\n")}
            >
              <span className="min-w-0 truncate text-sm font-semibold">{widget.title}</span>
              {unit ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{unit}</span> : null}
            </span>
          );
        }
        // #104: the cut is in the name's middle; the unit and the labels, which tell two panels of
        // one metric apart, are never cut (13c, 13d). The whole of both is one hover on the title.
        // #164: the name is cut to the room the panel gives it, and never reads as another metric.
        return (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-[3px] font-mono text-xs">
            <FitName
              lead={`${metricReading(view.kind, step, true, view.reading)} · `}
              name={view.name}
              trail={more > 0 ? ` + ${more}` : ""}
              others={canvasMetricNames}
              title={[
                `${metricReading(view.kind, step, false, view.reading)} · ${view.name}${unit ? ` · ${unit}` : ""} · ${view.kind}`,
                labels.map(([k, v]) => `${k}:${v}`).join(" · "),
              ]
                .filter(Boolean)
                .join("\n")}
            />
            {unit ? <span className="shrink-0 text-xs text-muted-foreground">{unit}</span> : null}
            {widget.metricSplit ? (
              <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-white/12 px-1.5 text-2xs text-muted-foreground">
                split {widget.metricSplit}
              </span>
            ) : null}
            {labels.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-violet-400/50 pl-1.5 text-2xs text-violet-300"
              >
                {k}:{v}
                <button
                  type="button"
                  aria-label={`Remove ${k}:${v}`}
                  title={`Remove ${k}:${v}`}
                  className="px-1 text-violet-300/80 hover:text-violet-200"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    const next = { ...widget.metricLabels };
                    delete next[k];
                    onWidgets(patchWidget(widgets, widget.id, { metricLabels: next }));
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        );
      }
      default: {
        const _exhaustive: never = widget.kind;
        return _exhaustive;
      }
    }
  }

  return (
    <HoverTimeProvider>
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
              variant="outline"
              className="gap-1.5 px-2.5 text-xs"
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
                className="h-7 gap-2.5 text-sm"
                onSelect={() => onAdd(kind)}
              >
                <span className="flex-1">{label}</span>
                <span className="font-mono text-2xs text-muted-foreground">{hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 24g: share any of these panels at once. */}
        <Button
          type="button"
          variant="outline"
          className="border-plate/50 bg-plate/10 px-2.5 text-xs"
          onClick={() => setSharing(widgets.filter((w) => w.kind !== "timeseries" || w.metric || w.id !== "a").map((w) => w.id))}
        >
          Share panels…
        </Button>
        <div className="flex h-[26px] items-center rounded-md border border-input p-0.5">
          <button
            type="button"
            className={cn(
              "h-[22px] rounded-sm px-2 text-xs",
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
              "h-[22px] rounded-sm px-2 text-xs",
              !logs ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={!logs}
            title="Charts only — the table stops loading pages"
            onClick={() => onLogs(false)}
          >
            Logs off
          </button>
        </div>
        {extras ? (
          <span
            className={cn(
              "min-w-0 truncate font-mono text-xs",
              atCap ? "text-warn-fg" : "text-muted-foreground",
            )}
          >
            {widgets.length}/{maxWidgets} panels
          </span>
        ) : null}
        {marks ? (
          <HistogramMarksChip overlay={marks} placement="bar" />
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
        }}
      >
        {dashGhost ? (
          <div
            className="z-0 rounded-lg border border-dashed border-ring bg-ring/10"
            style={{
              gridColumn: `${dashGhost.x + 1} / span ${dashGhost.w}`,
              gridRow: `${canvasY(dashGhost.y) + 1} / span ${dashGhost.h}`,
            }}
          />
        ) : null}
        {displayWidgets.map((widget) => {
          const data = lookup(widget);
          const updated: ReactNode = live ? (
            <WidgetUpdated fetchedAt={data.fetchedAt} now={now} />
          ) : null;
          const pinned = isPinnedHistogram(widget);
          const moving = grid.moving === widget.id;
          const sizing = grid.sizing === widget.id;
          const dragging = moving || sizing;
          // A moved panel stays drawn at its old cell, lifted under the pointer; the dashed cell is where it lands.
          const at = moving && grid.movingFrom ? grid.movingFrom : widget;
          const isFresh = fresh === widget.id;
          const hbarRowsPainted = widget.kind === "hbar"
            ? hbarPaintedRows(widget.split, widget.attr, data.values ?? [], data.total, widget.n)
            : [];
          return (
            <div
              key={widget.id}
              data-panel={widget.id}
              data-grid-cell={widget.id}
              className={cn(
                "group/cell relative min-h-0 min-w-0",
                "transition-[box-shadow] duration-500",
                isFresh ? "rounded-lg shadow-[0_0_0_3px_oklch(0.552_0.016_285.938_/_30%)]" : "",
              )}
              style={{
                zIndex: dragging ? 30 : pinned ? 2 : 1,
                gridColumn: `${at.x + 1} / span ${at.w}`,
                gridRow: `${canvasY(at.y) + 1} / span ${at.h + (pinned ? extraRows : 0)}`,
                transform:
                  moving && grid.lift
                    ? `translate(${Math.round(grid.lift.dx)}px, ${Math.round(grid.lift.dy)}px)`
                    : undefined,
                pointerEvents: moving ? "none" : undefined,
                opacity: moving ? 0.96 : undefined,
              }}
            >
              {pinned ? (
                <div className="flex h-full min-h-0 flex-col">
                {(() => {
                  const lines = linesOf(widget);
                  const note = lines ? panelNote(widget, lines) : null;
                  if (editingId === widget.id) {
                    const patch = (next: Partial<WidgetDef>) => onWidgets(patchWidget(widgets, widget.id, next));
                    return (
                      <>
                        <div className="flex min-w-0 items-center gap-2 px-3 pt-2">
                          <PanelTitleField widget={widget} madeTitle={madeTitleOf(widget)} onTitle={(title) => patch({ title })} />
                          {data.agg?.unit ? (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">{printUnit(data.agg.unit)}</span>
                          ) : null}
                        </div>
                        <PanelNoteField widget={widget} onNote={(next) => patch({ note: next })} />
                      </>
                    );
                  }
                  return (
                    <>
                      <PanelTitle widget={widget} unit={printUnit(data.agg?.unit)} />
                      <PanelNote note={note} leftOff={lines?.leftOff ?? []} />
                    </>
                  );
                })()}
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
                        metricSplit: null,
                      }),
                    )
                  }
                  onMetric={(next) => onWidgets(patchWidget(widgets, widget.id, { metric: next }))}
                  metricSplit={widget.metricSplit ?? null}
                  onMetricSplit={(next) =>
                    onWidgets(patchWidget(widgets, widget.id, { metricSplit: next }))
                  }
                  replaceY={widget.replaceY}
                  onReplaceY={(on) =>
                    onWidgets(patchWidget(widgets, widget.id, { replaceY: on }))
                  }
                  aggResult={data.agg}
                  numericKeys={numericKeys}
                  metricNames={metricNames}
                  updated={updated}
                  head={head}
                  editor={editorFor(widget)}
                  lineInfo={legendInfo(linesOf(widget))}
                  compactToolbar={widget.w < 8}
                  boardAction={
                    addToBoard && !locked ? (
                      <AddToBoardButton boards={addToBoard.boards} onPick={(boardId) => addToBoard.onPick(widget, boardId)} />
                    ) : null
                  }
                  lockChrome={locked}
                  retentionMs={retentionMs}
                  scanReason={scanReason}
                  marks={locked ? undefined : marks}
                  focusMarkId={focusMarkId}
                  onFocusMark={onFocusMark}
                  compareFold={locked ? undefined : compareFold}
                  onCompareLines={setCompareLines}
                  className="min-h-0 flex-1"
                />
                </div>
              ) : (
                <ExtraPanel
                  widget={widget}
                  armed={armed === widget.id}
                  atCap={atCap}
                  moving={Boolean(moving)}
                  highlight={isFresh}
                  lockChrome={locked}
                  identity={extraIdentity(widget, data)}
                  onShare={locked ? undefined : () => setSharing([widget.id])}
                  headControls={
                    widget.kind === "hbar" && !locked ? (
                      <TopViewPicker
                        value={widget.topView === "donut" ? "donut" : "bars"}
                        onChange={(next) =>
                          onWidgets(
                            patchWidget(widgets, widget.id, {
                              topView: next === "donut" ? "donut" : undefined,
                              // 25i: a donut reads best at five slices and other; a custom N stays.
                              ...(next === "donut" && widget.n === defaultHbarN ? { n: 5 } : {}),
                            }),
                          )
                        }
                      />
                    ) : widget.kind === "timeseries" && widget.metric && !widget.metric.startsWith("heatmap:") && !locked ? (
                      <MetricChartPicker
                        value={widget.metricChart ?? "line"}
                        stackable={metricStackable(data.agg, widget.metricSplit ?? null)}
                        onChange={(next) => onWidgets(patchWidget(widgets, widget.id, { metricChart: next }))}
                      />
                    ) : null
                  }
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
                  onMovePointerDown={(e) => grid.beginMove(e, widget.id)}
                  onNote={locked ? undefined : (note) => onWidgets(patchWidget(widgets, widget.id, { note }))}
                  showNote={!(widget.kind === "timeseries" && widget.metric)}
                  addToBoard={
                    addToBoard && !locked
                      ? { boards: addToBoard.boards, onPick: (boardId) => addToBoard.onPick(widget, boardId) }
                      : undefined
                  }
                >
                  {extraBody(widget, data, updated)}
                </ExtraPanel>
              )}
              {locked || (grid.dragging && !sizing) ? null : (
                <GridHandles
                  edges={gridEdges(pinned)}
                  active={sizing ? grid.sizingEdge : null}
                  onPointerDown={(e, edge) => grid.beginResize(e, widget.id, edge)}
                />
              )}
              {sizing ? <GridSizeChip w={widget.w} h={widget.h} /> : null}
            </div>
          );
        })}
      </div>
      <SharePanelsDialog
        open={sharing !== null}
        onOpenChange={(next) => {
          if (!next) setSharing(null);
        }}
        panels={widgets.map((w) => ({ widget: w, title: w.title?.trim() || widgetTitle(w) }))}
        picked={sharing ?? []}
        query={query ?? ""}
        range={panelRange(spanMs)}
      />
    </div>
    </HoverTimeProvider>
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
