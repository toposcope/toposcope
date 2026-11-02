import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HbarWidget } from "@/components/hbar-widget";
import { QueryText } from "@/components/query-text";
import { CountText } from "@/components/count-text";
import { cn } from "@/lib/utils";
import { copyWidgetSeries, downloadWidgetSeries, hbarExport, histogramExport, statExport, widgetExportFormats } from "@/export-series";
import { downloadExport, exportEvents } from "@/export-events";
import { parseRangeMs } from "../../query/relative";
import { widgetGridCols, widgetGapPx, widgetRowPx, hbarRows } from "../../shared/widgets";
import {
  BOARD_MAX,
  BOARD_PANEL_MAX,
  inputTokens,
  panelQuery,
  panelWhat,
  setInputs,
  type BoardPanel,
  type BoardSlots,
} from "../boards";
import {
  fetchFieldValues,
  fetchPanel,
  panelMergeable,
  type PanelData,
  type PanelWindow,
} from "../board-panel-data";
import { abbrevCount, formatAggStat, histogramAxisLabels } from "../fill-histogram";
import { seriesColor, seriesKeys, seriesValue } from "../histogram-series";
import type { FacetValue } from "../types";

const quickFixed = ["15m", "1h", "4h", "24h", "7d"] as const;
const liveDeltaMs = 2_000;
const liveFullMs = 30_000;

type Props = {
  board: BoardSlots;
  bind: Record<string, string>;
  /** The board's window: every panel reads it unless it has a fixed window. */
  win: PanelWindow;
  /** `1h`, as the Fixed window menu names the board's window (39g). */
  winLabel: string;
  live: boolean;
  readOnly: boolean;
  onBind: (key: string, value: string | null) => void;
  onBoard: (next: BoardSlots) => void;
  onOpenHunt: (panel: BoardPanel) => void;
  onEditPanel: (panel: BoardPanel) => void;
  onDuplicate: (panel: BoardPanel) => void;
  onRemove: (panel: BoardPanel) => void;
};

/** A board (#410, frames 39b–39g): its inputs, then its panels on the 12-col grid. */
export function BoardView(props: Props) {
  const { board, bind, win, live } = props;
  const [data, setData] = useState<Record<string, PanelData>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const dataRef = useRef(data);
  dataRef.current = data;
  const winKey = JSON.stringify(win);
  const plan = useMemo(
    () =>
      board.panels.map((panel) => {
        const q = panelQuery(panel.q, board.keys, bind);
        const panelWin: PanelWindow = panel.fixed ? { range: panel.fixed } : win;
        const { x: _x, y: _y, w: _w, h: _h, ...view } = panel.widget;
        return { panel, q, win: panelWin, key: JSON.stringify([panel.view, view, q, panelWin]) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, bind, winKey],
  );
  const planRef = useRef(plan);
  planRef.current = plan;

  // A full read of every panel whose query, view or window changed.
  const keys = plan.map((item) => item.key).join("\n");
  useEffect(() => {
    const ac = new AbortController();
    const items = planRef.current;
    setLoading(new Set(items.map((item) => item.panel.id)));
    for (const item of items) {
      void fetchPanel(item.panel, item.q, item.win, ac.signal)
        .then((next) => {
          if (!ac.signal.aborted) {
            setData((prev) => ({ ...prev, [item.panel.id]: next }));
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!ac.signal.aborted) {
            setLoading((prev) => {
              const out = new Set(prev);
              out.delete(item.panel.id);
              return out;
            });
          }
        });
    }
    return () => ac.abort();
  }, [keys]);

  // Live (#410): mergeable panels ask for what is new every 2s; every panel reads its whole window every 30s.
  useEffect(() => {
    if (!live) {
      return;
    }
    const ac = new AbortController();
    let lastFull = Date.now();
    const id = setInterval(() => {
      const full = Date.now() - lastFull >= liveFullMs;
      if (full) {
        lastFull = Date.now();
      }
      for (const item of planRef.current) {
        const prev = dataRef.current[item.panel.id];
        if (!full && !panelMergeable(item.panel)) {
          continue;
        }
        void fetchPanel(item.panel, item.q, item.win, ac.signal, full ? null : prev)
          .then((next) => {
            if (!ac.signal.aborted && !next.error) {
              setData((all) => ({ ...all, [item.panel.id]: next }));
            }
          })
          .catch(() => undefined);
      }
    }, liveDeltaMs);
    return () => {
      clearInterval(id);
      ac.abort();
    };
  }, [live, keys]);

  const rows = Math.max(1, ...board.panels.map((panel) => panel.widget.y + panel.widget.h));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardInputsRow
        keys={board.keys}
        bind={bind}
        win={win}
        readOnly={props.readOnly}
        onBind={props.onBind}
        onKeys={(next) => props.onBoard({ ...board, keys: next })}
      />
      <div className="min-h-0 flex-1 overflow-auto px-3 pt-1 pb-3">
        {board.panels.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">No panels</div>
        ) : (
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${widgetGridCols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, ${widgetRowPx}px)`,
              gap: `${widgetGapPx}px`,
            }}
          >
            {plan.map((item) => (
              <div
                key={item.panel.id}
                className="min-h-0 min-w-0"
                style={{
                  gridColumn: `${item.panel.widget.x + 1} / span ${item.panel.widget.w}`,
                  gridRow: `${item.panel.widget.y + 1} / span ${item.panel.widget.h}`,
                }}
              >
                <BoardPanelCard
                  panel={item.panel}
                  inputs={inputTokens(board.keys, bind)}
                  setKeys={setInputs(board.keys, bind)}
                  data={data[item.panel.id] ?? null}
                  loading={loading.has(item.panel.id)}
                  win={item.win}
                  boardWinLabel={props.winLabel}
                  live={live && !("from" in item.win)}
                  readOnly={props.readOnly}
                  atCap={board.panels.length >= BOARD_PANEL_MAX}
                  onOpenHunt={() => props.onOpenHunt(item.panel)}
                  onEdit={() => props.onEditPanel(item.panel)}
                  onFixed={(fixed) =>
                    props.onBoard({
                      ...board,
                      panels: board.panels.map((p) => (p.id === item.panel.id ? { ...p, fixed } : p)),
                    })
                  }
                  onDuplicate={() => props.onDuplicate(item.panel)}
                  onRemove={() => props.onRemove(item.panel)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BoardInputsRow({
  keys,
  bind,
  win,
  readOnly,
  onBind,
  onKeys,
}: {
  keys: string[];
  bind: Record<string, string>;
  win: PanelWindow;
  readOnly: boolean;
  onBind: (key: string, value: string | null) => void;
  onKeys: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [fieldKeys, setFieldKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (!adding) {
      return;
    }
    const ac = new AbortController();
    const params = new URLSearchParams("range" in win ? { range: win.range } : { from: win.from, to: win.to });
    void fetch(`/api/attr-keys?${params.toString()}`, { signal: ac.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ keys: Array<{ k: string }> }>) : { keys: [] }))
      .then((json) => setFieldKeys(json.keys.map((item) => item.k)))
      .catch(() => undefined);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, JSON.stringify(win)]);
  const offered = ["service", "host", "level", ...(fieldKeys ?? [])].filter((key, i, all) => !keys.includes(key) && all.indexOf(key) === i);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
      <span className="mr-1 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">Inputs</span>
      {keys.map((key) => (
        <InputChip
          key={key}
          field={key}
          value={bind[key] ?? null}
          win={win}
          readOnly={readOnly}
          onPick={(value) => onBind(key, value)}
          onRemove={() => {
            onBind(key, null);
            onKeys(keys.filter((item) => item !== key));
          }}
        />
      ))}
      {readOnly || keys.length >= BOARD_MAX ? null : (
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="h-8 rounded-md border border-dashed border-white/20 px-2.5 text-[12.5px] text-muted-foreground hover:border-ring hover:text-foreground"
            >
              + input
            </button>
          </PopoverTrigger>
          <PopoverContent className="max-h-72 w-56 overflow-auto bg-[#18181b] p-1">
            {offered.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No fields</div>
            ) : (
              offered.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="flex h-[26px] w-full items-center rounded-[3.4px] px-2 text-left font-mono text-[12px] hover:bg-accent"
                  onClick={() => {
                    setAdding(false);
                    onKeys([...keys, key]);
                  }}
                >
                  {key}
                </button>
              ))
            )}
          </PopoverContent>
        </Popover>
      )}
      <span className="text-[12.5px] text-muted-foreground">Added to every panel&apos;s query.</span>
    </div>
  );
}

function InputChip({
  field,
  value,
  win,
  readOnly,
  onPick,
  onRemove,
}: {
  field: string;
  value: string | null;
  win: PanelWindow;
  readOnly: boolean;
  onPick: (value: string | null) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FacetValue[] | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const ac = new AbortController();
    void fetchFieldValues(field, "", win, ac.signal, 10)
      .then(setValues)
      .catch(() => undefined);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, field, JSON.stringify(win)]);
  const row = "flex h-[26px] w-full items-center gap-2 rounded-[3.4px] px-2 text-left text-[12.5px] hover:bg-accent";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[12.5px] hover:bg-accent",
            value ? "border-white/45" : "border-input",
          )}
        >
          <span className="text-muted-foreground">{field}</span>
          <span className={value ? "text-foreground" : "text-muted-foreground"}>{value ?? "any"}</span>
          <span className="text-[9px] text-muted-foreground" aria-hidden>
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-56 overflow-auto bg-[#18181b] p-1">
        <button type="button" className={row} onClick={() => { setOpen(false); onPick(null); }}>
          <span className={cn("flex-1 font-mono", value ? "text-muted-foreground" : "text-foreground")}>any</span>
        </button>
        {(values ?? []).map((item) => (
          <button
            key={item.v}
            type="button"
            className={cn(row, value === item.v && "bg-accent")}
            onClick={() => {
              setOpen(false);
              onPick(item.v);
            }}
          >
            <span className="min-w-0 flex-1 truncate font-mono">{item.v}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
              <CountText n={item.n} />
            </span>
          </button>
        ))}
        {values === null ? <div className="mx-2 my-1.5 h-3 w-24 animate-pulse rounded bg-muted" /> : null}
        {readOnly ? null : (
          <>
            <div className="my-1 h-px bg-white/[0.08]" />
            <button
              type="button"
              className={cn(row, "text-muted-foreground")}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Remove input
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

type CardProps = {
  panel: BoardPanel;
  inputs: string;
  setKeys: Array<[string, string]>;
  data: PanelData | null;
  loading: boolean;
  win: PanelWindow;
  boardWinLabel: string;
  live: boolean;
  readOnly: boolean;
  atCap: boolean;
  onOpenHunt: () => void;
  onEdit: () => void;
  onFixed: (fixed: string | null) => void;
  onDuplicate: () => void;
  onRemove: () => void;
};

function msUnit(agg: string | null): string | null {
  if (!agg) {
    return null;
  }
  if (agg === "rate") {
    return "/s";
  }
  return /_ms\)?$/.test(agg) || /:.*_ms$/.test(agg) ? "ms" : null;
}

/** The window a panel says it read (`last 24h`). */
function windowWords(win: PanelWindow): string {
  return "range" in win ? `the last ${win.range}` : "this window";
}

function BoardPanelCard(props: CardProps) {
  const { panel, data, loading } = props;
  const widget = panel.widget;
  const total = data?.total ?? 0;
  const empty = Boolean(data && !data.error && total === 0 && props.setKeys.length > 0);
  const [armed, setArmed] = useState(false);
  const head = panelHead(panel, data, props.live);
  return (
    <div className="group/panel flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-card">
      {armed ? (
        // Remove confirms in the panel's head, as a hunt panel's does.
        <div className="flex shrink-0 items-center gap-2 bg-destructive/14 py-2 pr-2 pl-3">
          <span className="min-w-0 truncate text-[12.5px] text-red-300">Remove {panel.name}?</span>
          <span className="min-w-1 flex-1" />
          <button
            type="button"
            className="h-[26px] rounded-md border border-destructive/55 bg-destructive/16 px-[9px] text-[12px] text-red-300 hover:bg-destructive/26"
            onClick={() => {
              setArmed(false);
              props.onRemove();
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="h-[26px] rounded-md border border-input px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setArmed(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
      <div className="flex shrink-0 items-center gap-2 pt-2.5 pr-2 pl-3">
        <span className="min-w-0 shrink truncate text-[13.5px] font-semibold">{panel.name}</span>
        <span className="min-w-0 shrink truncate font-mono text-[11.5px] text-muted-foreground">
          {panelWhat(panel.view, widget)}
        </span>
        {panel.fixed ? (
          <span className="shrink-0 rounded-[4px] border border-white/40 px-1.5 font-mono text-[11px] leading-[17px]">
            {panel.fixed} · fixed
          </span>
        ) : null}
        <span className="min-w-1 flex-1" />
        {head ? (
          <span className="shrink-0 font-mono text-[12px] whitespace-nowrap text-muted-foreground">
            <b className="font-medium text-foreground">{head.n ?? <CountText n={total} />}</b> {head.label}
          </span>
        ) : null}
        <PanelMenu {...props} onRemove={() => setArmed(true)} />
      </div>
      )}
      <div className="flex shrink-0 items-center gap-3 truncate px-3 pt-1 text-[12.5px]">
        {panel.q ? <QueryText q={panel.q} /> : <span className="font-mono text-muted-foreground">all logs</span>}
        {props.inputs ? <span className="font-mono">{props.inputs}</span> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {data?.error ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-amber-400">{data.error}</div>
        ) : data?.refused && total === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-amber-400">{data.refused}</div>
        ) : empty ? (
          <EmptyTell panel={panel} setKeys={props.setKeys} win={props.win} />
        ) : loading && !data ? (
          <div className="m-3 flex-1 animate-pulse rounded bg-muted/40" />
        ) : data ? (
          <PanelBody panel={panel} data={data} win={props.win} live={props.live} />
        ) : null}
      </div>
    </div>
  );
}

/** What a panel's head says: its series' last value, or how many rows match; null when its body says it. */
export function panelHead(panel: BoardPanel, data: PanelData | null, live: boolean): { n: string | null; label: string } | null {
  const widget = panel.widget;
  const total = data?.total ?? 0;
  const numeric = panel.view === "histogram" && Boolean(widget.agg || widget.metric);
  const statNumeric = panel.view === "stat" && Boolean(widget.metric || (widget.agg && widget.agg !== "count"));
  if (data === null) {
    return null;
  }
  if (numeric && total > 0) {
    const lastValue = lastAggValue(data);
    return { n: lastValue === null ? "—" : formatAggStat(lastValue), label: live ? "now" : "last" };
  }
  return statNumeric && total > 0 ? null : { n: null, label: "matching" };
}

function lastAggValue(data: PanelData | null): number | null {
  const buckets = data?.agg?.buckets ?? [];
  for (let i = buckets.length - 1; i >= 0; i--) {
    const v = buckets[i]!.v;
    if (Number.isFinite(v)) {
      return v;
    }
  }
  return null;
}

function PanelMenu(props: CardProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"more" | "fixed" | "copy" | "export">("more");
  const row =
    "flex h-[30px] w-full items-center gap-2 rounded-[3.4px] px-2 text-left text-[13px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45";
  const sep = <div className="my-1 h-px bg-white/[0.08]" />;
  function close() {
    setOpen(false);
    setPage("more");
  }
  const { panel, data } = props;
  function file() {
    if (!data) {
      return null;
    }
    if (panel.view === "stat") {
      return statExport({ series: panelWhat(panel.view, panel.widget), value: data.agg?.stat ?? data.total, total: data.total });
    }
    if (panel.view === "top") {
      return hbarExport(hbarRows(data.values ?? [], panel.widget.n, data.total));
    }
    return histogramExport(data.histogram, data.agg);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPage("more");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          aria-label="Panel actions"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("bg-[#18181b] p-1", page === "fixed" ? "w-[300px]" : "w-[196px]")}>
        {page === "more" ? (
          <>
            <button type="button" className={row} onClick={() => { close(); props.onOpenHunt(); }}>
              Open as hunt
            </button>
            {props.readOnly ? null : (
              <>
                <button type="button" className={row} onClick={() => { close(); props.onEdit(); }}>
                  Edit panel
                </button>
                <button type="button" className={row} onClick={() => setPage("fixed")}>
                  Fixed window…
                </button>
              </>
            )}
            {sep}
            {props.readOnly ? null : (
              <button type="button" className={row} disabled={props.atCap} onClick={() => { close(); props.onDuplicate(); }}>
                Duplicate
              </button>
            )}
            <button type="button" className={row} disabled={!data} onClick={() => setPage("copy")}>
              Copy…
            </button>
            <button type="button" className={row} disabled={!data} onClick={() => setPage("export")}>
              Export…
            </button>
            {props.readOnly ? null : (
              <>
                {sep}
                <button type="button" className={cn(row, "text-red-300")} onClick={() => { close(); props.onRemove(); }}>
                  Remove
                </button>
              </>
            )}
          </>
        ) : page === "fixed" ? (
          <FixedWindowMenu
            fixed={panel.fixed}
            boardWinLabel={props.boardWinLabel}
            onFixed={(next) => {
              props.onFixed(next);
              close();
            }}
          />
        ) : panel.view === "events" ? (
          (["csv", "json", "ndjson"] as const).map((format) => (
            <button
              key={format}
              type="button"
              className={row}
              onClick={() => {
                const events = data?.events ?? [];
                if (page === "copy") {
                  void navigator.clipboard
                    .writeText(exportEvents(events, format).body)
                    .then(() => toast.success(`${format.toUpperCase()} copied`))
                    .catch(() => toast.error("Copy failed"));
                } else {
                  downloadExport(events, format);
                }
                close();
              }}
            >
              <span className="flex-1">{format.toUpperCase()}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">.{format}</span>
            </button>
          ))
        ) : (
          widgetExportFormats.map((format) => (
            <button
              key={format}
              type="button"
              className={row}
              onClick={() => {
                const out = file();
                if (out) {
                  if (page === "copy") {
                    void copyWidgetSeries(out, format).then((ok) =>
                      ok ? toast.success(`${format.toUpperCase()} copied`) : toast.error("Copy failed"),
                    );
                  } else {
                    downloadWidgetSeries(out, format);
                  }
                }
                close();
              }}
            >
              <span className="flex-1">{format.toUpperCase()}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">.{format}</span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Fixed window (39g): follow the board, or read a relative window of its own. */
function FixedWindowMenu({
  fixed,
  boardWinLabel,
  onFixed,
}: {
  fixed: string | null;
  boardWinLabel: string;
  onFixed: (next: string | null) => void;
}) {
  const [on, setOn] = useState(Boolean(fixed));
  const radio = (checked: boolean) => (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
        checked ? "border-foreground" : "border-white/35",
      )}
    >
      {checked ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
    </span>
  );
  return (
    <div className="flex flex-col gap-0.5 p-0.5">
      <button
        type="button"
        className={cn("flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-accent", !on && "bg-accent/60")}
        onClick={() => onFixed(null)}
      >
        {radio(!on)}
        <span className="flex-1">Follow the board</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">{boardWinLabel}</span>
      </button>
      <button
        type="button"
        className={cn("flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-accent", on && "bg-accent/60")}
        onClick={() => setOn(true)}
      >
        {radio(on)}
        <span className="flex-1">Fixed window</span>
      </button>
      {on ? (
        <div className="flex flex-wrap gap-1.5 py-1.5 pl-8">
          {quickFixed.map((range) => (
            <button
              key={range}
              type="button"
              className={cn(
                "h-7 rounded-md border px-2.5 font-mono text-[12px] hover:bg-accent",
                fixed === range ? "border-foreground" : "border-input",
              )}
              onClick={() => onFixed(range)}
            >
              {range}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** An empty panel with an input set (39c): what the input found on the panel's own rows. */
function EmptyTell({
  panel,
  setKeys,
  win,
}: {
  panel: BoardPanel;
  setKeys: Array<[string, string]>;
  win: PanelWindow;
}) {
  const [tell, setTell] = useState<{ key: string; values: FacetValue[] } | null>(null);
  const setKey = JSON.stringify(setKeys);
  const winKey = JSON.stringify(win);
  useEffect(() => {
    const ac = new AbortController();
    setTell(null);
    void (async () => {
      for (const [key, value] of setKeys) {
        const values = await fetchFieldValues(key, panel.q, win, ac.signal);
        if (ac.signal.aborted) {
          return;
        }
        if (!values.some((item) => item.v === value)) {
          setTell({ key, values });
          return;
        }
      }
    })().catch(() => undefined);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.q, setKey, winKey]);
  const heading = `No rows with ${setKeys.map(([key, value]) => `${key}:${value}`).join(" ")}`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <span className="text-[13.5px]">{heading}</span>
      {tell ? (
        tell.values.length === 0 ? (
          <span className="text-[12.5px] text-muted-foreground">
            {panel.q || "These rows"} {panel.q ? "has" : "have"} no {tell.key} field in {windowWords(win)}.
          </span>
        ) : (
          <>
            <span className="text-[12.5px] text-muted-foreground">{tell.key} on these rows:</span>
            <div className="flex flex-wrap justify-center gap-1.5">
              {tell.values.map((item) => (
                <span key={item.v} className="rounded-md border border-input px-2 py-0.5 font-mono text-[12px]">
                  {item.v} <span className="text-muted-foreground">{abbrevCount(item.n)}</span>
                </span>
              ))}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

const levelText: Record<string, string> = {
  debug: "text-zinc-400",
  info: "text-sky-400",
  warn: "text-amber-400",
  error: "text-red-400",
  fatal: "text-red-300",
};

function PanelBody({
  panel,
  data,
  win,
  live,
}: {
  panel: BoardPanel;
  data: PanelData;
  win: PanelWindow;
  live: boolean;
}) {
  const widget = panel.widget;
  switch (panel.view) {
    case "stat": {
      const isCount = !widget.metric && (!widget.agg || widget.agg === "count");
      const refused = data.agg?.source === "refused";
      const value = isCount ? abbrevCount(data.total) : refused ? "—" : formatAggStat(data.agg?.stat ?? null);
      const unit = isCount ? null : (msUnit(widget.agg) ?? data.agg?.unit ?? null);
      return (
        <div className="flex flex-1 flex-col justify-center px-3 pb-3">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[40px] leading-none font-medium tracking-[-0.025em] tabular-nums">{value}</span>
            {unit ? <span className="font-mono text-[16px] text-muted-foreground">{unit}</span> : null}
          </div>
          <span className={cn("mt-2 font-mono text-[12px]", refused ? "text-amber-400" : "text-muted-foreground")}>
            {refused ? data.agg?.reason : isCount ? `in ${windowWords(win).replace("the ", "")}` : <><CountText n={data.total} /> rows</>}
          </span>
        </div>
      );
    }
    case "top":
      return (
        <HbarWidget
          view={widget.topView === "donut" ? "donut" : "bars"}
          split={widget.split}
          attr={widget.attr}
          values={data.values ?? []}
          total={data.total}
          loading={false}
          n={widget.n}
          pct={widget.pct}
        />
      );
    case "events":
      return (
        <div className="min-h-0 flex-1 overflow-auto px-3 pt-2">
          <table className="w-full table-fixed font-mono text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                <th className="w-[150px] pb-1.5 font-normal">Time</th>
                <th className="w-[90px] pb-1.5 font-normal">Level</th>
                <th className="w-[140px] pb-1.5 font-normal">Service</th>
                <th className="pb-1.5 font-normal">Message</th>
              </tr>
            </thead>
            <tbody>
              {(data.events ?? []).map((event) => (
                <tr key={`${event.ts}:${event.message}`} className="border-t border-white/[0.07]">
                  <td className="py-1 whitespace-nowrap">{event.ts.slice(11, 23)}</td>
                  <td className={cn("py-1", levelText[event.level])}>{event.level}</td>
                  <td className="truncate py-1">{event.service}</td>
                  <td className="truncate py-1">{event.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "histogram":
      return <PanelPlot panel={panel} data={data} live={live} />;
    default: {
      const _exhaustive: never = panel.view;
      return _exhaustive;
    }
  }
}

/** A board panel's plot: bars by its split, or its series as a filled line (39b). */
export function PanelPlot({ panel, data, live }: { panel: BoardPanel; data: PanelData; live: boolean }) {
  const widget = panel.widget;
  const buckets = data.histogram;
  const fromMs = data.from ? Date.parse(data.from) : NaN;
  const spanMs = data.from && data.to ? Date.parse(data.to) - fromMs : 0;
  const ticks = widget.w >= 8 ? 5 : 3;
  const labels = histogramAxisLabels(fromMs, spanMs, live, Date.now(), ticks);
  const numeric = Boolean(widget.agg || widget.metric);
  const axis = (
    <div className="flex shrink-0 justify-between pt-1.5 font-mono text-[11px] text-muted-foreground">
      {labels.map((label, i) => (
        <span key={`${label}:${i}`}>{label}</span>
      ))}
    </div>
  );
  if (numeric) {
    if (data.agg?.source === "refused") {
      return <div className="flex flex-1 items-center justify-center px-4 text-[12.5px] text-amber-400">{data.agg.reason}</div>;
    }
    const byT = new Map((data.agg?.buckets ?? []).map((b) => [b.t, b.v]));
    const vals = buckets.length > 0 ? buckets.map((b) => byT.get(b.t) ?? null) : (data.agg?.buckets ?? []).map((b) => b.v);
    const finite = vals.filter((v): v is number => v !== null && Number.isFinite(v));
    const peak = Math.max(1e-9, ...finite);
    const n = Math.max(1, vals.length);
    const pts: string[] = [];
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        return;
      }
      pts.push(`${(((i + 0.5) / n) * 200).toFixed(2)},${(60 - (v / peak) * 56).toFixed(2)}`);
    });
    const first = pts[0]?.split(",")[0];
    const last = pts.at(-1)?.split(",")[0];
    return (
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2.5">
        <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="min-h-0 w-full flex-1">
          {pts.length > 1 ? <polygon points={`${first},60 ${pts.join(" ")} ${last},60`} fill="oklch(0.68 0.15 237 / 14%)" /> : null}
          <polyline
            points={pts.join(" ")}
            fill="none"
            stroke="oklch(0.75 0.15 237)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {axis}
      </div>
    );
  }
  const keys = seriesKeys(buckets, widget.split);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.n));
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2.5">
      <div className="flex min-h-0 flex-1 items-end gap-[3px]">
        {buckets.map((bucket) => (
          <div key={bucket.t} className="flex h-full min-w-0 flex-1 flex-col-reverse">
            {keys.map((key, si) => {
              const n = seriesValue(bucket, key, widget.split);
              if (n <= 0) {
                return null;
              }
              return (
                <div
                  key={key}
                  className="w-full"
                  style={{ height: `${(n / peak) * 100}%`, background: seriesColor(key, widget.split, si) }}
                />
              );
            })}
          </div>
        ))}
      </div>
      {axis}
    </div>
  );
}

/** How long a relative range is, for the board's window label; null when it is not one. */
export function relativeLabel(range: string): string | null {
  return parseRangeMs(range) === null ? null : range;
}
