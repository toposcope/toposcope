import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Span, TraceResponse } from "../../shared/span";
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
  onFollow: (key: string, value: string, ts: string) => void;
  followDisabled?: boolean;
  followTitle?: string;
  onViewProfiles: (span: Span) => void;
};

const grid = "grid grid-cols-[minmax(0,340px)_66px_minmax(0,1fr)] gap-2.5";

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
  onViewProfiles,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  const spans = result?.spans ?? [];
  const total = result?.total ?? 0;
  const tree = useMemo(() => flattenTrace(spans), [spans]);
  const services = useMemo(() => servicesOf(spans), [spans]);
  const selectedSpan = spans.find((span) => span.span_id === selected) ?? null;
  const hoverSpan = spans.find((span) => span.span_id === hover?.id) ?? null;
  const hoverRow = tree.rows.find((row) => row.span.span_id === hover?.id);
  const chain = selected ? ancestorIds(spans, selected) : new Set<string>();
  const empty = !loading && !failed && spans.length === 0;
  const capped = total > spans.length && spans.length > 0;
  const clock = ts.slice(11, 19);

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
      className="flex min-h-0 flex-1 flex-col px-3 pb-3"
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
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {joinKey}:{joinValue}
        </span>
      </div>

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
            {failed ? "Could not load this trace" : "No spans for this request"}
          </span>
          <span className="max-w-[420px] text-center text-xs leading-relaxed text-pretty text-muted-foreground">
            {failed
              ? "The request failed."
              : "This trace is not stored yet — sampled, not exported, expired, or still arriving."}
          </span>
          {failed ? null : (
            <button
              type="button"
              className="mt-2 h-7 rounded-[4.4px] border border-white/15 px-3 text-[12.5px] hover:bg-accent disabled:cursor-default disabled:opacity-35"
              title={followTitle}
              disabled={followDisabled}
              onClick={() => onFollow(joinKey, joinValue, ts)}
            >
              Follow this id instead
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
              grid,
              "relative h-[26px] items-center border border-b-0 border-white/10 bg-background/45 px-2.5",
            )}
          >
            <span />
            <span />
            <span className="relative h-full">
              {ticks.map((tick) => (
                <span
                  key={tick.frac}
                  className="absolute top-[7px] font-mono text-[10px] text-muted-foreground"
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
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto border border-white/10 bg-card",
              selectedSpan ? "border-b-0" : "rounded-b-[6.4px]",
            )}
          >
            {tree.missingParent ? (
              <div
                className={cn(
                  grid,
                  "h-[26px] items-center border-b border-dashed border-white/15 px-2.5",
                )}
              >
                <span className="font-mono text-[11px] text-amber-300">
                  missing parent · {tree.orphanCount} spans start here
                </span>
                <span />
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
                    grid,
                    "h-[26px] cursor-pointer items-center border-b border-white/5 px-2.5",
                    on ? "bg-accent/70" : inChain ? "bg-white/[0.03]" : "",
                  )}
                  onClick={() =>
                    setSelected((prev) =>
                      prev === row.span.span_id ? null : row.span.span_id,
                    )
                  }
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
          {selectedSpan ? (
            <div className="flex shrink-0 items-start gap-3.5 rounded-b-[6.4px] border border-t-0 border-white/10 bg-background/55 px-2.5 py-2">
              <div className="min-w-0 shrink">
                <div className="truncate font-mono text-xs">
                  {selectedSpan.service} · {selectedSpan.name}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  +{formatTraceMs(tree.rows.find((row) => row.span.span_id === selected)?.startMs ?? 0)}{" "}
                  · {formatTraceMs(selectedSpan.duration_ms)} total ·{" "}
                  {formatTraceMs(tree.rows.find((row) => row.span.span_id === selected)?.selfMs ?? 0)}{" "}
                  self
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1">
                {Object.entries(selectedSpan.attrs).map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex min-w-0 items-baseline gap-1.5 font-mono text-[11px]"
                  >
                    <span className="text-muted-foreground">{k}</span>
                    <span className="min-w-0 truncate">{v}</span>
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[4.4px] border border-white/15 px-2.5 text-xs hover:bg-accent"
                title={`Flamegraph of the profile samples linked to this span · span_id:${selectedSpan.span_id}`}
                onClick={() => onViewProfiles(selectedSpan)}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="0" y="0.5" width="12" height="3" rx="1" />
                  <rect x="0" y="4.5" width="8" height="3" rx="1" />
                  <rect x="2.5" y="8.5" width="4" height="3" rx="1" />
                </svg>
                View profiles
              </button>
              <button
                type="button"
                className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[4.4px] text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Clear selection"
                aria-label="Clear selection"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
