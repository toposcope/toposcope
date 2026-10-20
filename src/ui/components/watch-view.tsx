import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../../shared/change-mark";
import { formatOpenFor } from "../../shared/monitor";
import type { MonitorCall, MonitorStretch, MonitorView, MonitorsResponse, PushResultRow } from "@/types";
import {
  clockAt,
  httpLane,
  laneKind,
  laneReadout,
  pushBands,
  pushDueLine,
  pushReadout,
  pushTicks,
  pushValue,
  resultCard,
  type LaneReadout,
  nowLabel,
  openCardLine,
  sentDots,
  sortForWatch,
  sourceOf,
  stretchSpans,
  watchFilters,
  watchMarks,
  watchRanges,
  watchTicks,
  type WatchFilter,
  type WatchRange,
} from "@/watch";

type Props = {
  data: MonitorsResponse | null;
  /** Saved searches exist, so a search monitor can be made. */
  canCreate: boolean;
  range: WatchRange;
  onRange: (range: WatchRange) => void;
  filter: WatchFilter;
  onFilter: (filter: WatchFilter) => void;
  marks: ChangeMark[];
  onNew: () => void;
  /** Open a monitor as a hunt: its search, with the monitor beside it (18i); at a stretch or a result when one is given. */
  onOpen: (monitor: MonitorView, stretch?: Pick<MonitorStretch, "opened_at" | "resolved_at">) => void;
};

const lrow = "grid grid-cols-[210px_minmax(0,1fr)_118px] items-center gap-3 px-3 py-1";
/** 18f: push lanes on their own, taller, with when the next result is due under the state. */
const prow = "grid grid-cols-[190px_minmax(0,1fr)_128px] items-center gap-3 border-b border-white/[0.06] px-3 py-1.5";

function Seg({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-[5px] rounded-[5px] px-[9px] text-[12px]",
        on ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: LaneReadout["tone"]; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10.5px] whitespace-nowrap",
        tone === "red"
          ? "bg-red-500/[0.16] text-red-300"
          : tone === "amber"
            ? "bg-amber-400/[0.14] text-amber-300"
            : tone === "out"
              ? "border border-white/[0.18] text-muted-foreground"
              : "bg-[#27272a] text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

function Grid({ ticks }: { ticks: Array<{ left: number }> }) {
  return (
    <>
      {ticks.map((t) => (
        <span
          key={t.left}
          className="absolute inset-y-0 w-px bg-white/[0.07]"
          style={{ left: `${(t.left * 100).toFixed(3)}%` }}
        />
      ))}
    </>
  );
}

/** An HTTP(S) run's tick (18c): an ok is a faint hairline, a warn or a fail taller and in colour. */
const runTone: Record<"ok" | "warn" | "fail", string> = {
  ok: "top-[5px] bottom-[5px] bg-[rgba(231,225,211,.7)]",
  warn: "top-[3px] bottom-[3px] bg-amber-400",
  fail: "top-[3px] bottom-[3px] bg-red-500/60",
};

function Lane({
  monitor,
  stretches,
  sent,
  results,
  fromMs,
  toMs,
  nowMs,
  ticks,
  onOpen,
}: {
  monitor: MonitorView;
  stretches: MonitorStretch[];
  sent: MonitorCall[];
  results: PushResultRow[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  ticks: Array<{ left: number }>;
  onOpen: Props["onOpen"];
}) {
  const fingerprints = sourceOf(monitor) === "fingerprints";
  const dots = fingerprints ? sentDots(sent.filter((c) => c.ok), fromMs, toMs) : [];
  const readout = laneReadout(monitor, nowMs, dots.length);
  // An HTTP(S) lane draws its runs (18c): a texture when they are dense, else a tick each.
  const runs = sourceOf(monitor) === "http" ? httpLane(results, monitor.http?.every_ms ?? 30_000, fromMs, toMs) : null;
  return (
    <div className={lrow} data-monitor={monitor.id}>
      <button
        type="button"
        className="flex min-w-0 flex-col items-start text-left"
        title={`Open ${monitor.name} in Search · opens a new tab`}
        onClick={() => onOpen(monitor)}
      >
        <span className="max-w-full truncate text-[12px] hover:underline">{monitor.name}</span>
        <span className="max-w-full truncate font-mono text-[10.5px] text-muted-foreground">{laneKind(monitor)}</span>
      </button>
      <span
        className="relative h-[18px] overflow-hidden rounded-[3px] bg-[#0f0f11]"
        style={
          runs?.dense && results.length > 0
            ? { backgroundImage: "repeating-linear-gradient(to right,rgba(231,225,211,.35) 0 1px,transparent 1px 3px)" }
            : undefined
        }
      >
        {runs?.dense && results.length > 0 ? null : <Grid ticks={ticks} />}
        {runs?.ticks.map((t) => (
          <span
            key={t.id}
            title={`${clockAt(t.result.at, nowMs)} ${t.result.result} · ${t.result.message}`}
            className={cn("absolute", runTone[t.tone], t.width > 0 ? "rounded-[1px]" : "")}
            style={{
              left: `${(t.left * 100).toFixed(3)}%`,
              width: t.width > 0 ? `max(2px, ${(t.width * 100).toFixed(3)}%)` : "2px",
            }}
          />
        ))}
        {stretchSpans(stretches, fromMs, toMs, nowMs).map((span) => {
          const end = span.stretch.resolved_at ?? nowMs;
          return (
            <button
              key={span.id}
              type="button"
              aria-label={`${monitor.name} open ${clockAt(span.stretch.opened_at, nowMs)}`}
              title={`${monitor.name} open ${clockAt(span.stretch.opened_at, nowMs)} → ${
                span.open ? "now" : clockAt(end, nowMs)
              } · ${formatOpenFor(end - span.stretch.opened_at)}${span.stretch.closed_by === "edit" ? " · closed by edit" : ""}`}
              onClick={() => onOpen(monitor, span.stretch)}
              className={cn(
                "absolute top-[3px] bottom-[3px]",
                span.open ? "bg-red-500" : "rounded-[2px] bg-red-500/45",
              )}
              style={{ left: `${(span.left * 100).toFixed(3)}%`, width: `${(span.width * 100).toFixed(3)}%` }}
            />
          );
        })}
        {dots.map((dot) => (
          <span
            key={dot.id}
            className="absolute top-[5px] size-2 rounded-full bg-plate"
            style={{ left: `calc(${(dot.left * 100).toFixed(3)}% - 4px)` }}
          />
        ))}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <Badge tone={readout.tone}>{readout.badge}</Badge>
        {readout.text ? (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={readout.title}>
            {readout.text}
          </span>
        ) : null}
      </span>
    </div>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

const tickTone: Record<PushResultRow["result"], string> = {
  ok: "bg-plate",
  warn: "bg-amber-400",
  fail: "bg-red-500",
};

const bandTone: Record<"late" | "open" | "resolved" | "running", string> = {
  late: "bg-amber-400/70",
  open: "bg-red-500",
  resolved: "bg-red-500/35",
  running: "border border-plate",
};

/** What a result said, beside its tick (18f). */
function ResultCard({
  monitor,
  result,
  stretches,
  nowMs,
  left,
  onOpen,
}: {
  monitor: MonitorView;
  result: PushResultRow;
  stretches: MonitorStretch[];
  nowMs: number;
  left: number;
  onOpen: Props["onOpen"];
}) {
  const card = resultCard(result, stretches, nowMs);
  // Toward the middle of the lane, so it never runs off either end.
  const place = left > 0.55 ? { right: pct(1 - left) } : { left: pct(left) };
  return (
    <div
      role="dialog"
      aria-label={`${monitor.name} result ${card.at}`}
      data-result-card
      className="absolute top-full z-20 mt-1 flex w-[300px] flex-col gap-1.5 rounded-[6.4px] border bg-[#1f1f23] px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
      style={place}
    >
      <span className="flex items-center gap-2">
        <Badge tone={card.tone}>{card.badge}</Badge>
        <span className="font-mono text-[12px]">{card.at}</span>
      </span>
      {card.ran ? <span className="font-mono text-[11px] text-muted-foreground">{card.ran}</span> : null}
      {card.message ? (
        <code className="max-h-[120px] overflow-hidden rounded-[4px] bg-[#0f0f11] px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-zinc-200 [overflow-wrap:anywhere]">
          {card.message}
        </code>
      ) : null}
      <span className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px] whitespace-nowrap"
          onClick={() => onOpen(monitor, card.stretch ?? { opened_at: result.at, resolved_at: result.at })}
        >
          Open in Search
        </Button>
        {card.opened ? <span className="text-[11px] text-muted-foreground">{card.opened}</span> : null}
      </span>
    </div>
  );
}

/**
 * A push monitor's lane (18f; on 18c's clock too): each result a tick (the worst of its column of
 * the clock), a run a bar back to its /start, its stretches red, late amber, and a dashed line at
 * the due time it waits for.
 */
function PushLane({
  monitor,
  stretches,
  results,
  fromMs,
  toMs,
  nowMs,
  ticks,
  tall,
  card,
  onCard,
  onOpen,
}: {
  monitor: MonitorView;
  stretches: MonitorStretch[];
  results: PushResultRow[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  ticks: Array<{ left: number }>;
  /** 18f's layout, on the Push segment. */
  tall: boolean;
  card: number | null;
  onCard: (resultId: number | null) => void;
  onOpen: Props["onOpen"];
}) {
  const paused = monitor.enabled === 0;
  const readout = pushReadout(monitor, nowMs, null);
  const marks = pushTicks(results, fromMs, toMs);
  const bands = pushBands(monitor, stretches, nowMs, fromMs, toMs);
  const due = pushDueLine(monitor, nowMs, fromMs, toMs);
  const unit = results.at(-1)?.unit ?? null;
  const value = pushValue(monitor.last_value, unit);
  const shown = card !== null ? marks.find((t) => t.id === card) : undefined;
  const inset = tall ? "top-[7px] bottom-[7px]" : "top-1 bottom-1";
  const bandInset = tall ? "top-1 bottom-1" : "top-[3px] bottom-[3px]";

  /** A click reads the nearest result within 6px; else the stretch under it opens as a hunt. */
  function onLane(e: React.MouseEvent<HTMLSpanElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) {
      return;
    }
    const x = (e.clientX - box.left) / box.width;
    const near = 6 / box.width;
    let best: { id: number; d: number } | null = null;
    for (const t of marks) {
      const d = x < t.left ? t.left - x : x > t.left + t.width ? x - (t.left + t.width) : 0;
      if (d <= near && (!best || d < best.d)) {
        best = { id: t.id, d };
      }
    }
    if (best) {
      onCard(best.id === card ? null : best.id);
      return;
    }
    const band = bands.find((b) => b.stretch && x >= b.left && x <= b.left + b.width && b.kind !== "late");
    if (band?.stretch) {
      onOpen(monitor, band.stretch);
    }
  }

  return (
    <div className={tall ? prow : lrow} data-monitor={monitor.id}>
      <button
        type="button"
        className="flex min-w-0 flex-col items-start text-left"
        title={`Open ${monitor.name} in Search · opens a new tab`}
        onClick={() => onOpen(monitor)}
      >
        <span className={cn("max-w-full truncate text-[12px] hover:underline", paused && "text-muted-foreground")}>
          {monitor.name}
        </span>
        <span className={cn("max-w-full truncate font-mono text-muted-foreground", tall ? "text-[11px]" : "text-[10.5px]")}>
          {laneKind(monitor)}
        </span>
      </button>
      <span className="relative">
        <span
          className={cn("relative block cursor-pointer overflow-hidden rounded-[3px] bg-[#0f0f11]", tall ? "h-[30px]" : "h-[18px]")}
          style={
            paused
              ? { backgroundImage: "repeating-linear-gradient(135deg,rgba(255,255,255,.05) 0 4px,transparent 4px 8px)" }
              : undefined
          }
          onClick={onLane}
        >
          <Grid ticks={ticks} />
          {bands.map((b) => (
            <span
              key={b.key}
              className={cn("absolute box-border", bandInset, bandTone[b.kind])}
              style={{ left: pct(b.left), width: pct(b.width) }}
            />
          ))}
          {marks.map((t) => (
            <span
              key={t.id}
              aria-hidden
              className={cn("absolute min-w-[2px] rounded-[1px]", inset, tickTone[t.tone], t.id === card && "outline outline-1 outline-white")}
              style={{ left: pct(t.left), width: t.width > 0 ? pct(t.width) : "2px" }}
            />
          ))}
          {due !== null ? (
            <span className="absolute inset-y-0 w-0 border-l border-dashed border-plate" style={{ left: pct(due) }} />
          ) : null}
        </span>
        {shown ? (
          <ResultCard
            monitor={monitor}
            result={shown.result}
            stretches={stretches}
            nowMs={nowMs}
            left={shown.left + shown.width}
            onOpen={onOpen}
          />
        ) : null}
      </span>
      {tall ? (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <Badge tone={readout.tone}>{readout.badge}</Badge>
          {readout.next ? (
            <span className="truncate font-mono text-[10.5px] text-muted-foreground">{readout.next}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone={readout.tone}>{readout.badge}</Badge>
          {value ? <span className="truncate font-mono text-[10.5px] text-muted-foreground">{value}</span> : null}
        </span>
      )}
    </div>
  );
}

function Triangle({ left }: { left: number }) {
  return (
    <svg
      viewBox="0 0 10 9"
      width="10"
      height="9"
      aria-hidden
      className="absolute top-[5px] text-plate"
      style={{ left: `calc(${(left * 100).toFixed(3)}% - 5px)` }}
    >
      <path fill="currentColor" d="M5 0 10 9H0Z" />
    </svg>
  );
}

/** Frame 18c: Watch, every monitor on one clock, open ones first. */
export function WatchView({ data, canCreate, range, onRange, filter, onFilter, marks, onNew, onOpen }: Props) {
  const monitors = data?.monitors ?? [];
  const nowMs = data?.now ?? Date.now();
  const fromMs = data ? Date.parse(data.from) : nowMs;
  const toMs = data ? Date.parse(data.to) : nowMs;
  const filters = watchFilters(monitors);
  const shown = sortForWatch(monitors).filter((m) => filter === "all" || sourceOf(m) === filter);
  const open = sortForWatch(monitors).filter((m) => m.state === "open" && m.open);
  const ticks = watchTicks(fromMs, toMs, range);
  const onClock = watchMarks(marks, fromMs, toMs);
  const byMonitor = new Map<string, MonitorStretch[]>();
  for (const s of data?.stretches ?? []) {
    byMonitor.set(s.monitor_id, [...(byMonitor.get(s.monitor_id) ?? []), s]);
  }
  const sentBy = new Map<string, MonitorCall[]>();
  for (const c of data?.sent ?? []) {
    sentBy.set(c.monitor_id, [...(sentBy.get(c.monitor_id) ?? []), c]);
  }
  const resultsBy = new Map<string, PushResultRow[]>();
  for (const r of data?.results ?? []) {
    resultsBy.set(r.monitor_id, [...(resultsBy.get(r.monitor_id) ?? []), r]);
  }
  // 18f: the Push segment draws push lanes taller, with when each is next due.
  const tall = filter === "push";
  const [card, setCard] = useState<{ monitor: string; result: number } | null>(null);
  useEffect(() => {
    if (!card) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCard(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-result-card]") && !target?.closest("[data-monitor]")) {
        setCard(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [card]);

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[14px] font-semibold">Watch</h1>
          <span className="inline-flex rounded-[7px] border border-white/10 bg-[#18181b] p-[2px]">
            {filters.map((f) => (
              <Seg key={f.id} on={filter === f.id} onClick={() => onFilter(f.id)}>
                {f.label} <span className="font-mono text-muted-foreground">{f.n}</span>
              </Seg>
            ))}
          </span>
          {tall ? (
            <span className="text-[12px] text-muted-foreground">
              Each tick is a result. A bar is a run, from its /start to its end. The dashed line is when the next one
              is due.
            </span>
          ) : null}
          <span className="ml-auto inline-flex rounded-[7px] border border-white/10 bg-[#18181b] p-[2px]">
            {watchRanges.map((id) => (
              <Seg key={id} on={range === id} onClick={() => onRange(id)}>
                {id}
              </Seg>
            ))}
          </span>
          <Button type="button" size="sm" onClick={onNew}>
            New monitor
          </Button>
        </div>

        {open.length > 0 && !tall ? (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {open.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-[6.4px] border bg-card px-3 py-2"
              >
                <span className="size-2.5 shrink-0 rounded-full bg-red-500" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px]">
                    {m.name}{" "}
                    <span className="text-muted-foreground">· open {formatOpenFor(nowMs - m.open!.opened_at)}</span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{openCardLine(m, nowMs)}</span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-[26px] text-[12px]"
                  onClick={() => onOpen(m, m.open!)}
                >
                  Open in Search
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {monitors.length === 0 ? (
          <div className="rounded-[6.4px] border bg-card px-3 py-8 text-center">
            <p className="text-sm">{data ? "No monitors yet." : "Loading monitors…"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {canCreate
                ? "A monitor opens when its search has at least, or fewer than, N lines in its window, or a URL it calls fails its conditions; it reminds while open, and says when it resolved."
                : "Save a search, then Watch this from the sidebar."}
            </p>
            {canCreate ? (
              <Button type="button" size="sm" className="mt-3" onClick={onNew}>
                New monitor
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="rounded-[6.4px] border bg-card py-1">
            <div className={cn(tall ? prow : lrow, "border-b-0 py-[3px]")}>
              <span />
              <span className="relative h-3.5">
                {ticks.map((t) => (
                  <span
                    key={t.left}
                    className="absolute top-0 -translate-x-1/2 font-mono text-[10.5px] text-muted-foreground"
                    style={{ left: `${(t.left * 100).toFixed(3)}%` }}
                  >
                    {t.label}
                  </span>
                ))}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{nowLabel(nowMs, range)}</span>
            </div>
            {shown.map((m) =>
              sourceOf(m) === "push" ? (
                <PushLane
                  key={m.id}
                  monitor={m}
                  stretches={byMonitor.get(m.id) ?? []}
                  results={resultsBy.get(m.id) ?? []}
                  fromMs={fromMs}
                  toMs={toMs}
                  nowMs={nowMs}
                  ticks={ticks}
                  tall={tall}
                  card={card?.monitor === m.id ? card.result : null}
                  onCard={(result) => setCard(result === null ? null : { monitor: m.id, result })}
                  onOpen={onOpen}
                />
              ) : (
                <Lane
                  key={m.id}
                  monitor={m}
                  stretches={byMonitor.get(m.id) ?? []}
                  sent={sentBy.get(m.id) ?? []}
                  results={resultsBy.get(m.id) ?? []}
                  fromMs={fromMs}
                  toMs={toMs}
                  nowMs={nowMs}
                  ticks={ticks}
                  onOpen={onOpen}
                />
              ),
            )}
            {tall ? null : (
            <div className={lrow}>
              <span className="flex flex-col">
                <span className="text-[12px]">marks</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">deploys and flags</span>
              </span>
              <span className="relative h-[18px]">
                {onClock.glyphs.map((g) => (
                  <Triangle key={g.id} left={g.left} />
                ))}
                {onClock.labels.map((l) => (
                  <span
                    key={`${l.left}-${l.text}`}
                    className="absolute top-0.5 font-mono text-[10.5px] whitespace-nowrap text-muted-foreground"
                    style={
                      l.end
                        ? { right: `calc(${((1 - l.left) * 100).toFixed(3)}% + 10px)` }
                        : { left: `calc(${(l.left * 100).toFixed(3)}% + 8px)` }
                    }
                  >
                    {l.text}
                  </span>
                ))}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {onClock.count} mark{onClock.count === 1 ? "" : "s"}
              </span>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
