import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { HeldSource } from "../../shared/held";
import type { Span, TraceResponse } from "../../shared/span";
import { enteredName, traceHeld, type HeldPart, type TraceChip } from "../trace-held";
import {
  ancestorIds,
  flattenTrace,
  formatTraceMs,
  spanServiceColor,
  TRACE_ERROR_HEX,
} from "../waterfall";

type Props = {
  joinKey: string;
  joinValue: string;
  ts: string;
  result: TraceResponse | null;
  loading: boolean;
  failed: boolean;
  onFollow: (key: string, value: string, ts: string) => Promise<void> | void;
  followDisabled?: boolean;
  followTitle?: string;
  /** The selected span is read in the rail, so the rows keep their height. */
  selected: string | null;
  onSelect: (spanId: string | null) => void;
  /** What this instance holds (#139, #330): where each source it pulls from stands, and its own name. */
  held?: { sources: HeldSource[]; now: number; here: string };
  /** Opens a source's link page from the amber line. */
  onOpenSourceLink?: (source: string) => void;
};

/** Names take at most 40%, so a narrow waterfall beside the rail keeps its bars readable. */
const grid = "grid grid-cols-[minmax(0,min(340px,40%))_66px_minmax(0,1fr)] gap-2.5";
/** On a linked instance, a column for the instance each span entered at (#330, 33d). */
const gridEntered = "grid grid-cols-[minmax(0,min(320px,36%))_66px_76px_minmax(0,1fr)] gap-2.5";

/** An instance's name as a small mono chip, as Search's source chips read. */
export function SourceChip({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[18px] max-w-full items-center truncate rounded-[4px] bg-white/[0.07] px-1.5 font-mono text-[10.5px] text-foreground/85"
      title={name}
    >
      {name}
    </span>
  );
}

/** A header chip: the instance, its spans here, and whether its source is caught up. */
function TraceSourceChipView({ chip }: { chip: TraceChip }) {
  const short = chip.state === "short";
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border bg-background/60 px-1.5 text-[11.5px] whitespace-nowrap",
        short ? "border-amber-400/45" : "border-white/12 text-muted-foreground",
      )}
    >
      <SourceChip name={chip.name} />
      <span className={short ? "text-amber-300" : undefined}>{chip.words}</span>
    </span>
  );
}

function Parts({ parts }: { parts: HeldPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.mono ? (
          <span key={i} className="font-mono">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function servicesOf(spans: Span[]): string[] {
  const seen: string[] = [];
  for (const span of spans) {
    if (!seen.includes(span.service)) {
      seen.push(span.service);
    }
  }
  return seen;
}

export function TraceWaterfall({
  joinKey,
  joinValue,
  ts,
  result,
  loading,
  failed,
  onFollow,
  followDisabled = false,
  followTitle,
  selected,
  onSelect,
  held,
  onOpenSourceLink,
}: Props) {
  const [finding, setFinding] = useState(false);
  const [hover, setHover] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  const spans = result?.spans ?? [];
  const total = result?.total ?? 0;
  const tree = useMemo(() => flattenTrace(spans), [spans]);
  const services = useMemo(() => servicesOf(spans), [spans]);
  const hoverSpan = spans.find((span) => span.span_id === hover?.id) ?? null;
  const hoverRow = tree.rows.find((row) => row.span.span_id === hover?.id);
  const chain = selected ? ancestorIds(spans, selected) : new Set<string>();
  const empty = !loading && !failed && spans.length === 0;
  const capped = total > spans.length && spans.length > 0;
  const clock = ts.slice(11, 19);
  const here = held?.here ?? "";
  const where = useMemo(
    () =>
      traceHeld({
        spans,
        sources: held?.sources ?? [],
        now: held?.now ?? Date.now(),
        here,
        baseMs: tree.baseMs,
        totalMs: tree.totalMs,
        at: Date.parse(ts),
      }),
    [spans, held?.sources, held?.now, here, tree.baseMs, tree.totalMs, ts],
  );
  const entered = where.linked;
  const rowGrid = entered ? gridEntered : grid;

  let rootLabel = "Trace";
  let totalLabel = "";
  let countLabel = loading ? "Loading…" : failed ? "failed" : "no spans";
  if (spans.length > 0) {
    const root = tree.rows[0]?.span;
    rootLabel = tree.missingParent
      ? "No root span"
      : root
        ? `${root.service} ${root.name}`
        : "Trace";
    totalLabel = formatTraceMs(tree.totalMs);
    countLabel = capped
      ? `${spans.length} of ${total} spans`
      : entered
        ? // A trace drawn from what is here never reads as complete while a source is short.
          `${tree.rows.length} spans here · ${services.length} services · entered at ${where.instances} ${where.instances === 1 ? "instance" : "instances"}`
        : `${tree.rows.length} spans · ${services.length} services`;
  }

  const startLabel = empty
    ? `joined on ${joinKey} · ${clock} UTC`
    : tree.missingParent
      ? `relative to the earliest span received · ${clock} UTC`
      : `relative to root start · ${clock} UTC`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    frac,
    label: formatTraceMs(tree.totalMs * frac),
  }));

  return (
    <div
      data-screen-label="Trace waterfall"
      className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-3"
    >
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 rounded-t-[6.4px] border border-b-0 border-white/10 bg-card px-2.5">
        <span className="truncate text-[13px] font-medium">{rootLabel}</span>
        {totalLabel ? (
          <span className="font-mono text-xs whitespace-nowrap">{totalLabel}</span>
        ) : null}
        <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">
          {countLabel}
        </span>
        <div className="min-w-2 flex-1" />
        {entered && where.chips.length > 0 ? (
          <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden" aria-label="Where its spans entered">
            {where.chips.map((chip) => (
              <TraceSourceChipView key={chip.name} chip={chip} />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {joinKey}:{joinValue}
        </span>
      </div>

      {where.line ? (
        <div
          role="status"
          className="flex items-center gap-2.5 border border-b-0 border-amber-400/40 bg-amber-400/[0.07] px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-200"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
          <span className="min-w-0 flex-1 text-pretty">
            <Parts parts={where.line} />
          </span>
          {where.lineSource && onOpenSourceLink ? (
            <button
              type="button"
              className="shrink-0 whitespace-nowrap text-amber-300 hover:text-amber-200"
              onClick={() => onOpenSourceLink(where.lineSource!)}
            >
              {where.lineSource}&apos;s link →
            </button>
          ) : null}
        </div>
      ) : null}

      {tree.missingParent || capped ? (
        <div className="flex flex-col gap-0.5 border border-b-0 border-white/10 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          {capped ? (
            <span>Over the 500-span cap — showing the slowest branches.</span>
          ) : null}
          {tree.missingParent ? (
            <span>
              Parent span was never received, so these subtrees have no root.
              Offsets start at the earliest span we have.
            </span>
          ) : null}
        </div>
      ) : null}

      {empty || failed ? (
        <div className="flex flex-col items-center gap-1 rounded-b-[6.4px] border border-white/10 bg-card px-5 py-14">
          <span className="text-[13px]">
            {failed ? "Could not load this trace" : where.short ? "No spans here for this request yet" : "No spans for this request"}
          </span>
          <span className="max-w-[420px] text-center text-xs leading-relaxed text-pretty text-muted-foreground">
            {failed
              ? "The request failed."
              : where.short
                ? "A source this instance pulls from is short at this time, so its spans may not be here yet."
                : "This trace is not stored yet — sampled, not exported, expired, or still arriving."}
          </span>
          {failed ? null : (
            <button
              type="button"
              className="mt-2 h-7 rounded-[4.4px] border border-white/15 px-3 text-[12.5px] hover:bg-accent disabled:cursor-default disabled:opacity-35"
              title={followTitle}
              disabled={followDisabled || finding}
              onClick={() => {
                setFinding(true);
                void Promise.resolve(onFollow(joinKey, joinValue, ts)).finally(() =>
                  setFinding(false),
                );
              }}
            >
              {finding ? "Finding first and last seen…" : "Follow this id instead"}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border border-b-0 border-white/10 bg-background/45 px-2.5 py-1.5 text-[11px] text-muted-foreground/80">
            {loading ? "Loading spans…" : startLabel}
          </div>
          <div
            className={cn(
              rowGrid,
              "relative h-[26px] items-center border border-b-0 border-white/10 bg-background/45 px-2.5",
            )}
          >
            <span />
            <span />
            {entered ? (
              <span className="text-[10px] tracking-[0.04em] text-muted-foreground uppercase">Entered at</span>
            ) : null}
            <span className="@container relative h-full">
              {ticks.map((tick) => (
                <span
                  key={tick.frac}
                  className={cn(
                    "absolute top-[7px] font-mono text-[10px] text-muted-foreground",
                    // Quarter ticks only where there is room for five labels.
                    (tick.frac === 0.25 || tick.frac === 0.75) && "@max-[280px]:hidden",
                  )}
                  style={{
                    left: `${tick.frac * 100}%`,
                    transform:
                      tick.frac === 0
                        ? "none"
                        : tick.frac === 1
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {tick.label}
                </span>
              ))}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-b-[6.4px] border border-white/10 bg-card">
            {tree.missingParent ? (
              <div
                className={cn(
                  rowGrid,
                  "h-[26px] items-center border-b border-dashed border-white/15 px-2.5",
                )}
              >
                <span className="font-mono text-[11px] text-amber-300">
                  missing parent · {tree.orphanCount} spans start here
                </span>
                <span />
                {entered ? <span /> : null}
                <span />
              </div>
            ) : null}
            {tree.rows.map((row) => {
              const on = selected === row.span.span_id;
              const inChain = chain.has(row.span.span_id);
              const err = row.span.status === "error";
              const color = err
                ? TRACE_ERROR_HEX
                : spanServiceColor(row.span.service, services);
              const left = tree.totalMs > 0 ? (row.startMs / tree.totalMs) * 100 : 0;
              const width =
                tree.totalMs > 0
                  ? Math.max(0.5, (row.span.duration_ms / tree.totalMs) * 100)
                  : 0.5;
              return (
                <div
                  key={row.span.span_id}
                  className={cn(
                    rowGrid,
                    "h-[26px] cursor-pointer items-center border-b border-white/5 px-2.5",
                    on ? "bg-accent/70" : inChain ? "bg-white/[0.03]" : "",
                  )}
                  aria-selected={on}
                  onClick={() => onSelect(on ? null : row.span.span_id)}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHover({
                      id: row.span.span_id,
                      top: r.bottom + 4,
                      left: Math.min(r.left, window.innerWidth - 252),
                    });
                  }}
                  onMouseLeave={() =>
                    setHover((prev) => (prev?.id === row.span.span_id ? null : prev))
                  }
                >
                  <div
                    className="flex min-w-0 items-center gap-1.5"
                    style={{ paddingLeft: row.depth * 14 }}
                  >
                    {row.depth > 0 ? (
                      <span className="mb-1.5 h-[7px] w-[7px] shrink-0 border-b border-l border-white/20" />
                    ) : null}
                    <span
                      className="h-[13px] w-0.5 shrink-0 rounded-full"
                      style={{ background: err ? TRACE_ERROR_HEX : "transparent" }}
                    />
                    <span
                      className={cn(
                        "min-w-0 truncate font-mono text-[11.5px]",
                        err ? "text-red-400" : "text-foreground",
                      )}
                    >
                      {row.span.name}
                    </span>
                    <span
                      className="shrink-0 rounded-[2.4px] px-1.5 font-mono text-[10px]"
                      style={{ background: `${color}22`, color }}
                    >
                      {row.span.service}
                    </span>
                  </div>
                  <span className="text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {formatTraceMs(row.span.duration_ms)}
                  </span>
                  {entered ? (
                    <span className="min-w-0">
                      <SourceChip name={enteredName(row.span, here)} />
                    </span>
                  ) : null}
                  <div
                    className="relative h-full min-w-0"
                    style={{
                      background:
                        "repeating-linear-gradient(to right, oklch(1 0 0 / 6%) 0 1px, transparent 1px 25%)",
                    }}
                  >
                    <div
                      className="absolute top-[7px] h-[11px] rounded-[2.4px]"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: color,
                        opacity: on || !selected ? 1 : 0.55,
                      }}
                    />
                  </div>
                </div>
              );
            })}
            {where.hatches.map((hatch) => (
              <div
                key={hatch.key}
                className={cn(rowGrid, "h-[34px] items-center border-b border-white/5 px-2.5")}
                style={{
                  background: "repeating-linear-gradient(135deg, rgba(251,191,36,0.10) 0 4px, transparent 4px 9px)",
                }}
              >
                <span className="min-w-0 truncate font-mono text-[11px] text-amber-300">{hatch.label}</span>
                <span />
                {entered ? (
                  <span className="min-w-0">
                    <SourceChip name={hatch.source} />
                  </span>
                ) : null}
                <div className="relative h-full min-w-0">
                  <div
                    className={cn(
                      "absolute inset-y-1",
                      hatch.kind === "hole" ? "border-x border-amber-400/70" : "border-l border-dashed border-amber-400",
                    )}
                    style={{ left: `${hatch.lo * 100}%`, width: `${Math.max(0, hatch.hi - hatch.lo) * 100}%` }}
                  />
                  <span
                    className="absolute top-[9px] font-mono text-[10.5px] whitespace-nowrap text-amber-300"
                    style={
                      hatch.lo > 0.7
                        ? { right: `${(1 - hatch.lo) * 100}%`, paddingRight: 6 }
                        : { left: `${hatch.lo * 100}%`, paddingLeft: 6 }
                    }
                  >
                    {hatch.tag}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {hover && hoverSpan && hoverRow ? (
            <div
              className="pointer-events-none fixed z-50 w-[236px] rounded-[6.4px] border border-white/14 bg-[#18181b] px-2.5 py-2 shadow-[0_12px_28px_oklch(0_0_0_/_55%)]"
              style={{ top: hover.top, left: hover.left }}
            >
              <div className="truncate font-mono text-[11.5px]">{hoverSpan.name}</div>
              <div className="mt-0.5 mb-1.5 font-mono text-[10.5px] text-muted-foreground">
                {hoverSpan.service}
              </div>
              {[
                ["start", `+${formatTraceMs(hoverRow.startMs)}`],
                ["duration", formatTraceMs(hoverSpan.duration_ms)],
                ["self", formatTraceMs(hoverRow.selfMs)],
                ...(entered ? [["entered at", enteredName(hoverSpan, here)]] : []),
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex h-4 items-center justify-between gap-3 font-mono text-[11px]"
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tabular-nums">{v}</span>
                </div>
              ))}
              {hoverSpan.attrs["status.message"] ? (
                <div className="mt-1.5 border-t border-white/10 pt-1.5 text-[11px] text-red-400">
                  {hoverSpan.attrs["status.message"]}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
