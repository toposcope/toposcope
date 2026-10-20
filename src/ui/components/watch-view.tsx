import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../../shared/change-mark";
import { formatOpenFor } from "../../shared/monitor";
import type { MonitorCall, MonitorStretch, MonitorView, MonitorsResponse } from "@/types";
import {
  clockAt,
  laneKind,
  laneReadout,
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
  /** Open a monitor as a hunt: its search, with the monitor beside it (18i); at a stretch when one is given. */
  onOpen: (monitor: MonitorView, stretch?: MonitorStretch) => void;
};

const lrow = "grid grid-cols-[210px_minmax(0,1fr)_118px] items-center gap-3 px-3 py-1";

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

function Badge({ tone, children }: { tone: "red" | "sec"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10.5px] whitespace-nowrap",
        tone === "red" ? "bg-red-500/[0.16] text-red-300" : "bg-[#27272a] text-zinc-300",
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

function Lane({
  monitor,
  stretches,
  sent,
  fromMs,
  toMs,
  nowMs,
  ticks,
  onOpen,
}: {
  monitor: MonitorView;
  stretches: MonitorStretch[];
  sent: MonitorCall[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  ticks: Array<{ left: number }>;
  onOpen: Props["onOpen"];
}) {
  const fingerprints = sourceOf(monitor) === "fingerprints";
  const dots = fingerprints ? sentDots(sent.filter((c) => c.ok), fromMs, toMs) : [];
  const readout = laneReadout(monitor, nowMs, dots.length);
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
      <span className="relative h-[18px] overflow-hidden rounded-[3px] bg-[#0f0f11]">
        <Grid ticks={ticks} />
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

        {open.length > 0 ? (
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
                ? "A monitor opens when its search has at least, or fewer than, N lines in its window, reminds while open, and says when it resolved."
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
            <div className={cn(lrow, "py-[3px]")}>
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
            {shown.map((m) => (
              <Lane
                key={m.id}
                monitor={m}
                stretches={byMonitor.get(m.id) ?? []}
                sent={sentBy.get(m.id) ?? []}
                fromMs={fromMs}
                toMs={toMs}
                nowMs={nowMs}
                ticks={ticks}
                onOpen={onOpen}
              />
            ))}
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
          </div>
        )}
      </div>
    </div>
  );
}
