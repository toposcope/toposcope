import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  aggFromOpSelect,
  applySeriesSelect,
  numericPickerOps,
  type SeriesPick,
  type SeriesSelectResult,
} from "../agg-picker";
import { pickedEntry, useSeriesCatalog, type SeriesCatalog } from "../series-catalog";
import type { HistogramReading } from "../../shared/metric";
import {
  buildSeriesList,
  metricReading,
  midCut,
  readingMenu,
  splitHit,
  type MetricEntry,
  type MetricView,
  type SeriesRow,
} from "../series-list";

const FN = "#a78bfa";
const DIM = "oklch(0.705 0.015 286.067)";
const FOCUS = "oklch(0.552 0.016 285.938)";

/** A toolbar control: 26px, the select box it replaces. */
const triggerBox =
  "inline-flex h-[26px] min-w-0 items-center gap-1.5 rounded-[4.4px] border bg-[#18181b] text-[11.5px] whitespace-nowrap text-foreground outline-none";

/** Dots become places a long name may wrap; it is never ellipsised in the list. */
const wrapAtDots = (text: string) => text.replaceAll(".", ".​");

type Variant = "toolbar" | "footer" | "head";

type Props = {
  /** Where it sits: the pinned toolbar, a timeseries footer, or a Stat head. */
  variant: Variant;
  /** A card counts by default; the pinned plot's series is off by default. */
  card: boolean;
  pick: SeriesPick;
  /** The log series as the URL has it. */
  agg: string | null;
  /** The picked metric as it is shown: its name, kind and reading. */
  view?: MetricView | null;
  onSeries: (next: SeriesSelectResult) => void;
};

/**
 * The Series control: a button that opens a list that can be typed into.
 * Off (Count on a card), Rate and the numeric log fields keep the top; metrics
 * follow, each with its kind in a word.
 */
export function SeriesPicker({ variant, card, pick, agg, view, onSeries }: Props) {
  const live = useSeriesCatalog();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(-1);
  /** While the list is open it holds still: Live keeps reordering what is behind it. */
  const [held, setHeld] = useState<SeriesCatalog | null>(null);
  const [found, setFound] = useState<MetricEntry[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const catalog = open && held ? held : live;

  const pickedName = pick.kind === "metric" ? pick.name : null;
  const entry = pickedEntry(live, pickedName, view?.kind);
  // An older link's `<name>.count` is listed, and labelled, as the histogram it reads.
  const picked = useMemo<MetricEntry | null>(
    () =>
      entry && view
        ? { ...entry, kind: view.kind, of: view.name !== entry.name ? view.name : undefined }
        : entry,
    [entry, view],
  );
  const typed = filter.trim();

  // Names past the ones loaded are asked for, a moment after the typing stops.
  useEffect(() => {
    if (!open || typed.length === 0 || catalog.metricTotal <= catalog.metrics.length) {
      setFound(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void catalog.find(typed).then((rows) => {
        if (!stale) {
          setFound(rows);
        }
      });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, typed, catalog]);

  const list = useMemo(
    () =>
      buildSeriesList({
        card,
        pick,
        picked,
        agg,
        numericKeys: catalog.numericKeys,
        metrics: found ?? catalog.metrics,
        metricTotal: catalog.metricTotal,
        filter,
        window: catalog.window,
      }),
    [card, pick, picked, agg, catalog, found, filter],
  );
  const rows = useMemo(() => list.sections.flatMap((section) => section.rows), [list]);
  /** While typing, Enter and the arrows start at the first match, past the row that is already picked. */
  const firstMatch = list.sections[0]?.id === "picked" ? list.sections[0].rows.length : 0;
  const gained = held
    ? live.metrics.filter((metric) => !held.metrics.some((old) => old.name === metric.name)).length
    : 0;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setHeld(live);
      setFilter("");
      setFound(null);
      setCursor(-1);
    } else {
      setHeld(null);
    }
  }

  function choose(row: SeriesRow) {
    onOpenChange(false);
    onSeries(applySeriesSelect(row.value, pick));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) {
        return;
      }
      const start = typed.length > 0 ? firstMatch - 1 : rows.findIndex((row) => row.on);
      const from = cursor < 0 ? start : cursor;
      const next = Math.min(rows.length - 1, Math.max(0, from + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor >= 0 ? cursor : typed.length > 0 ? firstMatch : rows.findIndex((r) => r.on)];
      if (row) {
        choose(row);
      }
    }
    // Arrow keys, Enter and the letters stay here; the search bar never sees them.
    e.stopPropagation();
  }

  const named = pick.kind === "metric" || pick.kind === "key";
  const fullName =
    pick.kind === "metric" ? (picked?.of ?? pick.name) : pick.kind === "key" ? pick.key : "";
  const kindWord = pick.kind === "key" ? "field" : pick.kind === "metric" ? (picked?.kind ?? "gauge") : "";
  const plainLabel = pick.kind === "rate" ? "Rate" : card ? "Count" : "Off";
  const cutAt = variant === "toolbar" ? 29 : variant === "footer" ? 13 : 17;
  const label = named ? midCut(fullName, cutAt) : plainLabel;
  const title = named ? `${fullName} · ${kindWord}` : plainLabel;

  let row = -1;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {variant === "head" ? (
          <button
            type="button"
            title={title}
            aria-label="Series"
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex min-w-0 max-w-full flex-1 items-center truncate border-none px-px font-mono text-[11.5px] leading-[1.55] outline-none"
            style={{
              color: "oklch(0.985 0 0)",
              borderBottom: `1px dashed ${open ? "oklch(0.985 0 0)" : "oklch(1 0 0 / 34%)"}`,
              background: open ? "oklch(1 0 0 / 10%)" : "transparent",
              borderRadius: 2,
            }}
          >
            <span className="truncate">{label}</span>
          </button>
        ) : (
          <button
            type="button"
            title={title}
            aria-label="Series"
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              triggerBox,
              variant === "footer" ? "flex-1 pr-[7px] pl-[7px]" : "max-w-[18rem] shrink pr-[7px]",
              variant === "toolbar" && (named ? "pl-1" : "pl-[7px]"),
            )}
            style={{
              borderColor: open ? FOCUS : "oklch(1 0 0 / 15%)",
              boxShadow: open ? "0 0 0 1px oklch(0.552 0.016 285.938 / 35%)" : undefined,
            }}
          >
            {named && variant === "toolbar" ? (
              <span
                className="h-[18px] shrink-0 rounded-[2.4px] bg-white/[0.08] px-[5px] text-[10px] leading-[18px]"
                style={{ color: DIM }}
              >
                {kindWord}
              </span>
            ) : null}
            <span className={cn("min-w-0 flex-1 overflow-hidden text-left", named && "font-mono")}>
              {label}
            </span>
            <span className="shrink-0 text-[8px]" style={{ color: DIM }}>
              ▾
            </span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="flex max-h-(--radix-popover-content-available-height) w-[336px] flex-col rounded-[6.4px] border-white/[0.12] bg-[#18181b] p-1 text-left text-[12px] shadow-[0_12px_28px_oklch(0_0_0/55%)]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="-mx-1 -mt-1 flex h-[30px] shrink-0 items-center gap-[7px] border-b border-white/[0.08] px-[9px]">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke={DIM}
            strokeWidth="2"
            className="shrink-0"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            autoFocus
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursor(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder="Find a field or metric"
            aria-label="Find a field or metric"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/65"
          />
          <kbd className="shrink-0 rounded-[2.4px] border border-white/[0.15] px-1 font-mono text-[9.5px] text-muted-foreground">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="flex min-h-0 shrink flex-col">
          {list.sections.map((section, si) => (
            <div
              key={section.id}
              className={cn(
                "flex flex-col",
                // Above the list's height only the metrics scroll, so the log fields never scroll away.
                section.id === "metrics" ? "min-h-0 shrink" : "shrink-0",
              )}
            >
              {section.head ? (
                <div
                  className={cn(
                    "flex shrink-0 items-baseline gap-1.5 px-[7px] pb-1 text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase",
                    si === 0 ? "pt-[7px]" : "mt-[3px] border-t border-white/[0.08] pt-2",
                  )}
                >
                  <span>{section.head}</span>
                  <span className="ml-auto font-mono text-[10px] tracking-normal text-muted-foreground/80 normal-case">
                    {section.meta}
                  </span>
                </div>
              ) : null}
              <div
                className={cn(
                  // Eight rows show; past that the metrics scroll, and on a short screen they give way first.
                  section.id === "metrics" && "max-h-[200px] min-h-[50px] shrink overflow-y-auto",
                )}
              >
                {section.rows.map((item) => {
                  row += 1;
                  const index = row;
                  const [pre, hit, post] = splitHit(item.name, item.plain ? "" : typed);
                  return (
                    <button
                      key={`${section.id}:${item.value}`}
                      type="button"
                      data-row={index}
                      className={cn(
                        "flex min-h-[25px] w-full items-start gap-[7px] rounded-[3.4px] px-[7px] py-[5px] text-left leading-[15px]",
                        index === cursor || (cursor < 0 && item.on && typed.length === 0)
                          ? "bg-accent"
                          : "bg-transparent hover:bg-accent",
                      )}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => choose(item)}
                    >
                      <span
                        className="w-[9px] shrink-0 text-[10px] leading-[15px] text-foreground"
                        style={{ opacity: item.on ? 1 : 0 }}
                      >
                        ✓
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 [overflow-wrap:anywhere]",
                          item.plain ? "text-[12px]" : "font-mono text-[11.5px]",
                          typed.length > 0 && !item.plain ? "text-foreground/[0.72]" : "text-foreground",
                        )}
                      >
                        {wrapAtDots(pre)}
                        {hit ? (
                          <span className="rounded-[2px] bg-white/[0.16] text-foreground">{wrapAtDots(hit)}</span>
                        ) : null}
                        {wrapAtDots(post)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[10px] leading-[15px]",
                          item.amber ? "text-amber-400" : "text-muted-foreground",
                        )}
                      >
                        {item.tag}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {list.more ? (
            <div className="mt-0.5 shrink-0 border-t border-dashed border-white/10 px-[7px] pt-[7px] pb-[5px] text-[11px] leading-[1.45] text-pretty text-muted-foreground">
              {list.more}
            </div>
          ) : null}
          {list.emptyTitle ? (
            <div className="px-[9px] py-3 text-[11.5px] leading-normal text-pretty text-muted-foreground">
              <div className="mb-1 text-foreground">{list.emptyTitle}</div>
              {list.emptyBody}
            </div>
          ) : null}
          {catalog.live ? (
            <div className="mt-[3px] flex shrink-0 gap-[7px] border-t border-white/[0.08] px-[7px] pt-[7px] pb-[5px] text-[11px] leading-[1.45] text-foreground/80">
              <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-[#4ade80]" />
              <span className="text-pretty">
                Live — held while open.
                {gained > 0
                  ? ` ${gained} more ${gained === 1 ? "metric" : "metrics"} gained points; they join the list when it next opens.`
                  : ""}
              </span>
            </div>
          ) : null}
        </div>

        <div className="-mx-1 mt-[3px] -mb-1 flex shrink-0 items-center gap-[5px] border-t border-white/[0.08] px-[9px] py-1.5 text-[10.5px] text-muted-foreground">
          <kbd className="rounded-[2.4px] border border-white/[0.15] px-1 font-mono text-[9.5px]">↑↓</kbd>
          <span>move</span>
          <kbd className="ml-1.5 rounded-[2.4px] border border-white/[0.15] px-1 font-mono text-[9.5px]">↵</kbd>
          <span>pick</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-muted-foreground/80">
            {typed.length > 0 && list.matches > 0 ? `${list.matches} match` : ""}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type ReadingProps = {
  variant: Variant;
  pick: SeriesPick;
  /** The picked metric as it is shown. */
  view?: MetricView | null;
  /** The bar width as the plot labels it: "1m". */
  step: string;
  onAgg: (next: string) => void;
  /** A histogram's reading was chosen. */
  onReading: (next: HistogramReading) => void;
};

/**
 * What sits beside the name. A log field's reducer is a choice, and so is a
 * histogram's reading. A gauge and a counter have one reading each, printed
 * and not a button, so a counter's sum cannot be read as a level.
 */
export function SeriesReading({ variant, pick, view, step, onAgg, onReading }: ReadingProps) {
  const [open, setOpen] = useState(false);
  const choice = pick.kind === "key" || (pick.kind === "metric" && view?.kind === "histogram");
  if (choice) {
    const histogram = pick.kind === "metric";
    const current = pick.kind === "key" ? pick.op : metricReading("histogram", step, false, view?.reading);
    const rows: ReadonlyArray<{ value: string; words: string }> = histogram
      ? readingMenu.map((row) => ({ value: row.reading, words: row.words }))
      : numericPickerOps.map((op) => ({ value: op, words: "" }));
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={histogram ? "Histogram reading" : "Series reducer"}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(triggerBox, "shrink-0 px-[7px] font-mono")}
            style={{
              borderColor: open ? FOCUS : "oklch(1 0 0 / 15%)",
              boxShadow: open ? "0 0 0 1px oklch(0.552 0.016 285.938 / 35%)" : undefined,
            }}
          >
            {current}
            <span className="text-[8px]" style={{ color: DIM }}>
              ▾
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className={cn("rounded-[6.4px] border-white/[0.12] bg-[#18181b] p-1", histogram ? "w-[244px]" : "w-[182px]")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="mb-0.5 border-b border-white/[0.08] px-[7px] pt-1 pb-[5px] text-[9.5px] tracking-[0.1em] uppercase"
            style={{ color: FN }}
          >
            {histogram ? "Reading · histogram" : "Function"}
          </div>
          {rows.map((row) => (
            <button
              key={row.value}
              type="button"
              className={cn(
                "flex h-[25px] w-full items-center gap-[7px] rounded-[3.4px] px-[7px] text-left font-mono text-[11.5px]",
                row.value === current ? "bg-accent" : "bg-transparent hover:bg-accent",
              )}
              onClick={() => {
                setOpen(false);
                if (pick.kind === "key") {
                  const next = aggFromOpSelect(row.value as (typeof numericPickerOps)[number], pick);
                  if (next) {
                    onAgg(next);
                  }
                  return;
                }
                onReading(row.value as HistogramReading);
              }}
            >
              <span
                className="w-[9px] shrink-0 text-[10px]"
                style={{ color: FN, opacity: row.value === current ? 1 : 0 }}
              >
                ✓
              </span>
              <span className={histogram ? "w-[38px] shrink-0" : undefined}>{row.value}</span>
              {row.words ? (
                <span className="min-w-0 truncate font-sans text-[11px] text-muted-foreground">{row.words}</span>
              ) : null}
            </button>
          ))}
          {histogram ? (
            <div className="-mx-1 mt-1 -mb-1 border-t border-white/[0.08] px-[9px] py-1.5 text-[10.5px] text-muted-foreground">
              Per bar. One reading is drawn at a time.
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    );
  }
  if (pick.kind !== "metric") {
    return null;
  }
  const metricKind = view?.kind ?? "gauge";
  const reading = metricReading(metricKind, step, variant !== "toolbar");
  const bar = step.length > 0 ? `its ${step}` : "it";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-[26px] shrink-0 cursor-help items-center px-0.5 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground underline decoration-white/35 decoration-dotted underline-offset-4"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {reading}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[300px] text-left">
        <div className="text-[11px]">
          {metricReading(metricKind, step)} — {metricKind}
        </div>
        <div className="mt-0.5 text-[10.5px] opacity-80">
          {metricKind === "counter"
            ? `Each bar is the sum of what arrived in ${bar}. Wider bars sum more. Not a level.`
            : "Each bar is the average of the values sent inside it."}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
