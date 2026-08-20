import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { eventKey, eventRowKeys } from "@/event-key";
import {
  formatEventClock,
  surroundingsTimeTrack,
  useTimestampFormat,
} from "@/event-time";
import { histogramWindowNeedsDate } from "@/fill-histogram";
import { stepIndex } from "@/keyboard";
import { isLoud, levelRail, levelVariant } from "@/level";
import { cn } from "@/lib/utils";
import { eventMatchesQuery } from "../../query/match-event";
import { surroundingMaxN } from "../../query/surrounding";
import type { ContextMode } from "../context-mode";
import { frozenQueryNote, surroundingTape } from "../surrounding-tape";
import type { LogEvent } from "../types";

export type { ContextMode };

type Surrounding = { before: LogEvent[]; after: LogEvent[] };

type Props = {
  event: LogEvent;
  selected: LogEvent | null;
  q: string;
  mode: ContextMode;
  n: number;
  fromMs: number;
  spanMs: number;
  onMode: (mode: ContextMode) => void;
  onMore: () => void;
  onSelect: (event: LogEvent) => void;
  strip?: ReactNode;
};

function pill(on: boolean): string {
  return cn(
    "h-[22px] rounded-sm px-2.5 text-xs",
    on
      ? "bg-accent text-foreground"
      : "bg-transparent text-muted-foreground hover:text-foreground",
  );
}

export function ContextView({
  event,
  selected,
  q,
  mode,
  n,
  fromMs,
  spanMs,
  onMode,
  onMore,
  onSelect,
  strip,
}: Props) {
  const format = useTimestampFormat();
  const needsDate = histogramWindowNeedsDate(fromMs, spanMs, Date.now());
  const gridStyle = {
    gridTemplateColumns: `${surroundingsTimeTrack(format, needsDate)} 60px 90px 92px minmax(0,1fr)`,
  };
  const scroller = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const userScroll = useRef(false);
  const [data, setData] = useState<Surrounding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = q.trim();
  const sendQ = mode === "match" && query.length > 0 ? query : undefined;

  const identity = `${event.ts}|${event.service}|${event.host ?? ""}|${sendQ ?? ""}`;
  const identityRef = useRef(identity);

  useEffect(() => {
    userScroll.current = false;
  }, [identity]);

  useEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      setData(null);
    }
    const params = new URLSearchParams({
      ts: event.ts,
      service: event.service,
      n: String(n),
    });
    if (event.host) {
      params.set("host", event.host);
    }
    if (sendQ) {
      params.set("q", sendQ);
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/search/context?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Surrounding failed (${res.status})`);
        }
        const json = (await res.json()) as Surrounding;
        if (!cancelled) {
          setData(json);
        }
      } catch (err) {
        if (!cancelled) {
          setData(null);
          setError(err instanceof Error ? err.message : "Surrounding failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, event.ts, event.service, event.host, n, sendQ]);

  useLayoutEffect(() => {
    if (!data || userScroll.current) {
      return;
    }
    const root = scroller.current;
    const row = root?.querySelector("[data-anchor-row='y']");
    row?.scrollIntoView({ block: "center" });
  }, [data, event.ts, event.service, mode, n]);

  const before = data?.before ?? [];
  const after = data?.after ?? [];
  const rows = data ? [...before, event, ...after] : [];
  const rowKeys = eventRowKeys(rows);
  const selectedKey = selected ? eventKey(selected) : eventKey(event);
  const moreBefore = n < surroundingMaxN && before.length >= n;
  const moreAfter = n < surroundingMaxN && after.length >= n;
  const title = `${event.service}${event.host ? ` · ${event.host}` : ""}`;
  const stamp = event.ts.slice(0, 19).replace("T", " ");
  const tape = surroundingTape([...before, event, ...after], event);

  useLayoutEffect(() => {
    const list = scroller.current;
    if (list && list.contains(document.activeElement)) {
      selectedRef.current?.focus();
    }
  }, [selectedKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[49px] shrink-0 items-center gap-2.5 border-b px-3">
        <Badge variant={levelVariant(event.level)}>{event.level}</Badge>
        <span className="font-mono text-xs whitespace-nowrap">{stamp}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {title}
        </span>
        <div className="min-w-2 flex-1" />
        <div className="flex h-[26px] shrink-0 items-center rounded-md border border-input p-0.5">
          <button
            type="button"
            className={pill(mode === "all")}
            onClick={() => onMode("all")}
          >
            All
          </button>
          <button
            type="button"
            className={pill(mode === "match")}
            onClick={() => onMode("match")}
          >
            Matching
          </button>
        </div>
      </div>
      <div className="shrink-0 border-b px-3 py-2 text-[11.5px] text-muted-foreground/90">
        {frozenQueryNote(mode, q)}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b bg-background/45 px-3">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {tape.from}
        </span>
        <span className="relative min-w-0 flex-1 h-6">
          {tape.ticks.map((tick) => (
            <span
              key={tick.key}
              className="absolute bottom-0 rounded-px"
              style={{
                left: `${tick.leftPct}%`,
                width: tick.width,
                height: tick.height,
                background: tick.color,
              }}
            />
          ))}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {tape.to}
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
          {tape.label}
        </span>
      </div>
      {strip}
      <div
        ref={scroller}
        data-kbd="table"
        className="min-h-0 flex-1 overflow-y-auto"
        onWheel={() => {
          userScroll.current = true;
        }}
        onPointerDown={(e) => {
          if (e.target instanceof Element && e.target.closest("button")) {
            return;
          }
          userScroll.current = true;
        }}
      >
        {error ? (
          <p className="px-2.5 py-2 text-xs text-destructive">{error}</p>
        ) : data === null ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {moreBefore ? (
              <button
                type="button"
                className="h-[30px] w-full border-b border-white/[0.08] text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={onMore}
              >
                Earlier
              </button>
            ) : null}
            {before.map((row, i) => (
              <ContextRow
                key={rowKeys[i] ?? eventKey(row)}
                event={row}
                q={q}
                mode={mode}
                selected={eventKey(row) === selectedKey}
                selectedRef={eventKey(row) === selectedKey ? selectedRef : undefined}
                rows={rows}
                fromMs={fromMs}
                spanMs={spanMs}
                format={format}
                gridStyle={gridStyle}
                onSelect={onSelect}
              />
            ))}
            <ContextRow
              event={event}
              q={q}
              mode={mode}
              current
              selected={eventKey(event) === selectedKey}
              selectedRef={eventKey(event) === selectedKey ? selectedRef : undefined}
              rows={rows}
              fromMs={fromMs}
              spanMs={spanMs}
              format={format}
              gridStyle={gridStyle}
              onSelect={onSelect}
            />
            {after.map((row, i) => (
              <ContextRow
                key={rowKeys[before.length + 1 + i] ?? eventKey(row)}
                event={row}
                q={q}
                mode={mode}
                selected={eventKey(row) === selectedKey}
                selectedRef={eventKey(row) === selectedKey ? selectedRef : undefined}
                rows={rows}
                fromMs={fromMs}
                spanMs={spanMs}
                format={format}
                gridStyle={gridStyle}
                onSelect={onSelect}
              />
            ))}
            {moreAfter ? (
              <button
                type="button"
                className="h-[30px] w-full border-t border-white/[0.08] text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={onMore}
              >
                Later
              </button>
            ) : null}
            {n >= surroundingMaxN ? (
              <p className="px-2.5 py-2 text-center text-[11px] text-muted-foreground/70">
                Context caps at {surroundingMaxN} each way
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ContextRow({
  event,
  q,
  mode,
  current,
  selected,
  selectedRef,
  rows,
  fromMs,
  spanMs,
  format,
  gridStyle,
  onSelect,
}: {
  event: LogEvent;
  q: string;
  mode: ContextMode;
  current?: boolean;
  selected: boolean;
  selectedRef?: Ref<HTMLButtonElement>;
  rows: LogEvent[];
  fromMs: number;
  spanMs: number;
  format: ReturnType<typeof useTimestampFormat>;
  gridStyle: CSSProperties;
  onSelect: (event: LogEvent) => void;
}) {
  const hit =
    !current && mode === "all" && q.trim() !== "" && eventMatchesQuery(event, q);
  const className = cn(
    "relative grid h-[26px] w-full items-center gap-2.5 border-b border-white/[0.06] px-2.5 pr-2.5 pl-3 text-left font-mono text-xs last:border-0",
    current
      ? "bg-accent"
      : selected
        ? "bg-accent/55"
        : hit
          ? "bg-sky-500/12"
          : "hover:bg-accent/45",
  );
  const body = (
    <>
      <span
        className={cn(
          "absolute inset-y-0 left-0",
          current ? "w-[3px] bg-foreground" : "w-0.5",
          current ? "" : hit ? "bg-sky-500" : levelRail[event.level],
        )}
      />
      <span className="truncate whitespace-nowrap text-muted-foreground" title={event.ts}>
        {formatEventClock(event.ts, { format, fromMs, spanMs })}
      </span>
      <Badge variant={levelVariant(event.level)}>{event.level}</Badge>
      <span className="truncate">{event.service}</span>
      <span className="truncate text-muted-foreground">{event.host ?? "—"}</span>
      <span
        className={cn(
          "truncate",
          current
            ? "text-foreground"
            : isLoud(event.level)
              ? "text-red-300"
              : event.level === "debug"
                ? "text-muted-foreground"
                : "",
        )}
      >
        {event.message}
      </span>
    </>
  );
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
    e.preventDefault();
    const i = rows.findIndex((row) => eventKey(row) === eventKey(event));
    const next = rows[stepIndex(i, e.key === "ArrowDown" ? 1 : -1, rows.length)];
    if (next) {
      onSelect(next);
    }
  }

  return (
    <button
      type="button"
      ref={selected ? selectedRef : undefined}
      tabIndex={selected ? 0 : -1}
      className={className}
      style={gridStyle}
      data-anchor-row={current ? "y" : "n"}
      onClick={() => onSelect(event)}
      onKeyDown={onKey}
    >
      {body}
    </button>
  );
}
