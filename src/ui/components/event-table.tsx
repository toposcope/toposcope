import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountText } from "@/components/count-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { eventRowKeys } from "@/event-key";
import { eventTableTimeTrack, formatEventClock, useTimestampFormat } from "@/event-time";
import { histogramWindowNeedsDate } from "@/fill-histogram";
import { stepIndex } from "@/keyboard";
import { downloadExport, exportScope, type ExportFormat } from "@/export-events";
import { isLoud, levelRail, levelVariant } from "@/level";
import { maxPromotedCols, parsePromotedCols } from "../../shared/attrs";
import {
  promoCellValue,
  promoExtraTracks,
  promoPicker,
  togglePromotedCol,
  type PromoMetrics,
  type PromoPickItem,
} from "../promoted-cols";
import type { LogEvent } from "@/types";

const gridClass = "grid gap-2";

type Props = {
  events: LogEvent[];
  selectedIndex: number;
  loading: boolean;
  total: number;
  q: string;
  range: string;
  fromMs: number;
  spanMs: number;
  showLoadMore: boolean;
  cols?: string[];
  onColsChange?: (cols: string[]) => void;
  onSelect: (index: number) => void;
  onMove: (index: number) => void;
  onOpenDetail: () => void;
  onCloseDetail: () => void;
  onLoadMore: () => void;
};

function useEventTableGrid(
  fromMs: number,
  spanMs: number,
  promoted: string[],
  metrics: Record<string, PromoMetrics>,
): {
  format: ReturnType<typeof useTimestampFormat>;
  style: CSSProperties;
} {
  const format = useTimestampFormat();
  const needsDate = histogramWindowNeedsDate(fromMs, spanMs, Date.now());
  const time = eventTableTimeTrack(format, needsDate);
  const extras = promoted.length > 0 ? ` ${promoExtraTracks(promoted, metrics)}` : "";
  const mid =
    promoted.length > 0
      ? "54px minmax(46px,54px) minmax(40px,62px)"
      : "54px minmax(46px,78px) minmax(40px,74px)";
  return {
    format,
    style: {
      gridTemplateColumns: `${time} ${mid}${extras} minmax(110px,1fr)`,
    },
  };
}

function PickRows({
  items,
  onToggle,
}: {
  items: PromoPickItem[];
  onToggle: (key: string) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.k}
          disabled={item.blocked}
          title={item.title}
          onSelect={(event) => {
            event.preventDefault();
            onToggle(item.k);
          }}
        >
          <span className="w-[9px] shrink-0 text-[10px] leading-none">{item.on ? "✓" : ""}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.k}</span>
          <span className="shrink-0 font-mono text-[10px] whitespace-nowrap text-muted-foreground">
            {item.meta}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function Header({
  style,
  promoted,
  suggested,
  other,
  atCap,
  metrics,
  onColsChange,
}: {
  style: CSSProperties;
  promoted: string[];
  suggested: PromoPickItem[];
  other: PromoPickItem[];
  atCap: boolean;
  metrics: Record<string, PromoMetrics>;
  onColsChange?: (cols: string[]) => void;
}) {
  const count = `${promoted.length}/${maxPromotedCols}`;
  return (
    <div
      className={`${gridClass} h-[26px] w-full min-w-0 shrink-0 items-center rounded-t-lg border border-b-0 bg-card px-2 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase`}
      style={style}
    >
      <span className="truncate">Time</span>
      <span className="truncate">Level</span>
      <span className="truncate">Service</span>
      <span className="truncate">Host</span>
      {promoted.map((key) => (
        <span
          key={key}
          className={`flex min-w-0 items-center gap-0.5 ${metrics[key]?.num ? "justify-end" : ""}`}
          title={`${key} — promoted column`}
        >
          <span className="min-w-0 truncate">{key}</span>
          {onColsChange ? (
            <button
              type="button"
              title={`Remove ${key}`}
              aria-label={`Remove ${key}`}
              className="flex size-[13px] shrink-0 items-center justify-center rounded-[2.4px] text-[12px] leading-none text-muted-foreground/55 hover:bg-white/12 hover:text-foreground"
              onClick={() => onColsChange(promoted.filter((item) => item !== key))}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">Message</span>
        {onColsChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={
                  atCap
                    ? `${promoted.length} of ${maxPromotedCols} fields — remove one to add another`
                    : promoted.length
                      ? `Add a field column — ${promoted.length} of ${maxPromotedCols}`
                      : "Show an attribute beside Message"
                }
                className={`ml-auto flex size-[18px] shrink-0 items-center justify-center rounded-[2.4px] text-[14px] leading-none ${
                  atCap
                    ? "text-muted-foreground/55"
                    : "text-muted-foreground hover:bg-white/10 hover:text-foreground"
                }`}
              >
                +
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              className="w-[242px] max-h-[min(324px,calc(100vh-180px))] overflow-y-auto p-1"
            >
              <div className="mb-1 flex items-center justify-between gap-2.5 border-b border-white/[0.08] px-2 py-1.5 normal-case tracking-normal">
                <span className="text-[11px] font-normal text-muted-foreground">Show in table</span>
                <span
                  className={`font-mono text-[10.5px] ${atCap ? "text-amber-400" : "text-muted-foreground"}`}
                >
                  {count}
                </span>
              </div>
              {suggested.length > 0 ? (
                <>
                  <div className="px-[7px] pt-[5px] pb-[3px] text-[10px] font-semibold tracking-[0.04em] text-muted-foreground/70 uppercase">
                    Suggested
                  </div>
                  <PickRows items={suggested} onToggle={(key) => onColsChange(togglePromotedCol(promoted, key))} />
                </>
              ) : null}
              {other.length > 0 ? (
                <>
                  <div className="px-[7px] pt-[5px] pb-[3px] text-[10px] font-semibold tracking-[0.04em] text-muted-foreground/70 uppercase">
                    Other keys on this page
                  </div>
                  <PickRows items={other} onToggle={(key) => onColsChange(togglePromotedCol(promoted, key))} />
                </>
              ) : null}
              {suggested.length === 0 && other.length === 0 ? (
                <p className="px-2 py-2 text-[11.5px] leading-snug font-normal normal-case tracking-normal text-muted-foreground">
                  No keys seen on this page yet
                </p>
              ) : null}
              <p className="mt-1 border-t border-white/[0.08] px-2 pt-1.5 pb-1 text-[10.5px] leading-normal font-normal normal-case tracking-normal text-muted-foreground">
                Keys seen in the loaded events on this page. Columns belong to this tab — Follow and
                Duplicate keep them, Save stores them.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </span>
    </div>
  );
}

function Footer({
  events,
  loaded,
  total,
  q,
  range,
  showLoadMore,
  onLoadMore,
}: {
  events: LogEvent[];
  loaded: number;
  total: number;
  q: string;
  range: string;
  showLoadMore?: boolean;
  onLoadMore?: () => void;
}) {
  const partial = Boolean(showLoadMore) || loaded < total;
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 rounded-b-lg border border-t-0 bg-card px-2">
      {loaded > 0 ? (
        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
          {partial ? (
            <>
              <CountText n={loaded} /> of <CountText n={total} /> events
            </>
          ) : (
            <>
              <CountText n={total} /> {total === 1 ? "event" : "events"}
            </>
          )}
        </span>
      ) : null}
      {showLoadMore && onLoadMore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-[26px] px-2.5 text-xs"
          onClick={onLoadMore}
        >
          Load more
        </Button>
      ) : null}
      <div className="min-w-0 flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-[26px] px-2.5 text-xs"
            disabled={events.length === 0}
          >
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="min-w-[196px] p-1">
          <div className="mb-1 border-b border-white/[0.08] px-2 py-1.5">
            <div className="truncate text-[11px] leading-snug">
              {exportScope(q, range)}
            </div>
            <div className="font-mono text-[10.5px] leading-normal text-muted-foreground">
              <CountText n={total} /> matching · <CountText n={loaded} /> loaded
            </div>
          </div>
          {(
            [
              ["csv", "CSV"],
              ["json", "JSON"],
              ["ndjson", "NDJSON"],
            ] as const satisfies ReadonlyArray<readonly [ExportFormat, string]>
          ).map(([format, label]) => (
            <DropdownMenuItem
              key={format}
              onSelect={() => downloadExport(events, format)}
            >
              {label}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                .{format === "ndjson" ? "ndjson" : format}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function EventTableSkeleton({
  fromMs,
  spanMs,
  cols = [],
}: {
  fromMs: number;
  spanMs: number;
  cols?: string[];
}) {
  const promoted = parsePromotedCols(cols);
  const { style } = useEventTableGrid(fromMs, spanMs, promoted, {});
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header style={style} promoted={promoted} suggested={[]} other={[]} atCap={false} metrics={{}} />
      <div className="min-h-0 flex-1 overflow-auto border bg-card">
        {Array.from({ length: 16 }, (_, i) => (
          <div
            key={i}
            className={`${gridClass} h-[26px] items-center border-b border-white/[0.06] px-2 last:border-0`}
            style={style}
          >
            <span className="h-2 animate-pulse rounded-sm bg-white/10" />
            <span className="h-2 w-10 animate-pulse rounded-sm bg-white/10" />
            <span className="h-2 w-[60px] animate-pulse rounded-sm bg-white/10" />
            <span className="h-2 w-[50px] animate-pulse rounded-sm bg-white/[0.08]" />
            {promoted.map((key, j) => (
              <span
                key={key}
                className="h-2 animate-pulse rounded-sm bg-white/[0.08]"
                style={{ width: `${26 + ((i + j * 3) * 17) % 32}px` }}
              />
            ))}
            <span
              className="h-2 animate-pulse rounded-sm bg-white/10"
              style={{ width: `${38 + ((i * 41) % 55)}%` }}
            />
          </div>
        ))}
      </div>
      <Footer loaded={0} total={0} events={[]} q="" range="1h" />
    </div>
  );
}

export function EventTable({
  events,
  selectedIndex,
  loading,
  total,
  q,
  range,
  fromMs,
  spanMs,
  showLoadMore,
  cols = [],
  onColsChange,
  onSelect,
  onMove,
  onOpenDetail,
  onCloseDetail,
  onLoadMore,
}: Props) {
  const promoted = parsePromotedCols(cols);
  const pick = promoPicker(events, promoted);
  const { format, style: gridStyle } = useEventTableGrid(
    fromMs,
    spanMs,
    promoted,
    pick.metrics,
  );
  const selectedRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
    const list = listRef.current;
    if (list && list.contains(document.activeElement)) {
      selectedRef.current?.focus();
    }
  }, [selectedIndex]);

  function onRowKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onMove(stepIndex(i, e.key === "ArrowDown" ? 1 : -1, events.length));
      return;
    }
    if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenDetail();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onCloseDetail();
    }
  }

  if (loading && events.length === 0) {
    return <EventTableSkeleton fromMs={fromMs} spanMs={spanMs} cols={promoted} />;
  }

  const rowKeys = eventRowKeys(events);
  const header = (
    <Header
      style={gridStyle}
      promoted={promoted}
      suggested={pick.suggested}
      other={pick.other}
      atCap={pick.atCap}
      metrics={pick.metrics}
      onColsChange={onColsChange}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <div ref={listRef} data-kbd="table" className="min-h-0 flex-1 overflow-auto border bg-card">
        {events.map((event, i) => {
          const selected = selectedIndex === i;
          return (
            <button
              key={rowKeys[i] ?? `${event.ts}:${i}`}
              ref={selected ? selectedRef : undefined}
              type="button"
              tabIndex={selected ? 0 : -1}
              className={`relative ${gridClass} h-[26px] w-full items-center border-b border-white/[0.06] px-2 text-left font-mono text-[12px] ${
                selected ? "bg-accent" : "hover:bg-accent/50"
              }`}
              style={gridStyle}
              onClick={() => onSelect(i)}
              onKeyDown={(e) => onRowKey(e, i)}
            >
              <span
                className={`absolute inset-y-0 left-0 w-0.5 ${levelRail[event.level]}`}
              />
              <span className="truncate text-muted-foreground" title={event.ts}>
                {formatEventClock(event.ts, { format, fromMs, spanMs })}
              </span>
              <Badge variant={levelVariant(event.level)}>{event.level}</Badge>
              <span className="truncate">{event.service}</span>
              <span className="truncate text-muted-foreground">
                {event.host ?? "—"}
              </span>
              {promoted.map((key) => {
                const value = promoCellValue(event, key);
                const numeric = pick.metrics[key]?.num;
                return (
                  <span
                    key={key}
                    className={`min-w-0 truncate ${numeric ? "text-right tabular-nums" : ""} ${
                      value === null ? "text-muted-foreground/40" : "text-muted-foreground"
                    }`}
                    title={value === null ? `${key} — not on this event` : `${key}=${value}`}
                  >
                    {value ?? "—"}
                  </span>
                );
              })}
              <span
                className={`truncate ${isLoud(event.level) ? "text-red-300" : ""}`}
              >
                {event.message}
              </span>
            </button>
          );
        })}
      </div>
      <Footer
        events={events}
        loaded={events.length}
        total={total}
        q={q}
        range={range}
        showLoadMore={showLoadMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}
