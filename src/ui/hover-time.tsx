import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../shared/change-mark";
import { MarkGlyph, markKindColor } from "@/components/histogram-marks";

/**
 * One hover line across a canvas (sheet 44): hover a time on any chart and every chart on the hunt
 * or board marks that moment. `source` is the chart under the pointer, so a chart that draws its own
 * hover hairline (the hunt's volume plot) skips the shared one while it is the source.
 */
type HoverTime = { ts: number; source: string } | null;
type Shared = { value: HoverTime; set: (next: HoverTime) => void };

const HoverTimeContext = createContext<Shared | null>(null);

export function HoverTimeProvider({ children }: { children: ReactNode }) {
  const [value, set] = useState<HoverTime>(null);
  const shared = useMemo(() => ({ value, set }), [value]);
  return <HoverTimeContext.Provider value={shared}>{children}</HoverTimeContext.Provider>;
}

export function useHoverTime(): Shared | null {
  return useContext(HoverTimeContext);
}

/** The span a row of buckets covers: the first start to the last end, in ms. */
export function bucketSpan(times: readonly string[]): { from: number; to: number } | null {
  const starts = times.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t));
  if (starts.length === 0) {
    return null;
  }
  const step = starts.length > 1 ? starts[1]! - starts[0]! : 60_000;
  return { from: starts[0]!, to: starts[starts.length - 1]! + step };
}

/** `14:32`, or `14:32:05` in a window under 15 minutes (UTC, as the window strip). */
export function hoverClock(ts: number, spanMs: number): string {
  return new Date(ts).toISOString().slice(11, spanMs < 15 * 60_000 ? 19 : 16);
}

/**
 * A chart's plot area: it publishes the time under the pointer, draws the shared hover line and
 * the window's change marks (◆ on a dashed tick, named on hover). `inset` is the plot's own padding.
 */
export function TimeLayer({
  id,
  from,
  to,
  marks = [],
  ownHover = false,
  className,
  inset = 0,
  children,
}: {
  id: string;
  from: number;
  to: number;
  marks?: readonly ChangeMark[];
  /** The chart draws its own hairline; the shared one shows only when another chart is hovered. */
  ownHover?: boolean;
  className?: string;
  inset?: number;
  children: ReactNode;
}) {
  const shared = useHoverTime();
  const span = to - from;
  const at = (ts: number) => `calc(${inset}px + ${((ts - from) / span) * 100}% - ${((ts - from) / span) * inset * 2}px)`;
  const hover = shared?.value;
  const showLine = hover && span > 0 && hover.ts >= from && hover.ts <= to && !(ownHover && hover.source === id);
  const inWindow = span > 0 ? marks.filter((mark) => {
    const ts = Date.parse(mark.ts);
    return ts >= from && ts <= to;
  }) : [];
  return (
    <div
      className={cn("relative", className)}
      onPointerMove={(e) => {
        if (!shared || span <= 0) {
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const width = rect.width - inset * 2;
        if (width <= 0) {
          return;
        }
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - inset) / width));
        shared.set({ ts: from + frac * span, source: id });
      }}
      onPointerLeave={() => {
        if (shared?.value?.source === id) {
          shared.set(null);
        }
      }}
    >
      {children}
      {inWindow.map((mark) => (
        <div
          key={mark.id}
          className="group/mark absolute top-0 bottom-0 z-[5] w-[11px] -translate-x-1/2"
          style={{ left: at(Date.parse(mark.ts)) }}
        >
          <span className="absolute top-[7px] bottom-0 left-1/2 border-l border-dashed opacity-70" style={{ borderColor: markKindColor(mark.kind) }} />
          <span className="absolute top-0 left-0">
            <MarkGlyph kind={mark.kind} size={11} />
          </span>
          <span className="pointer-events-none absolute top-0 left-[14px] z-10 hidden rounded-sm border border-white/14 bg-popover px-1.5 font-mono text-2xs leading-[18px] whitespace-nowrap group-hover/mark:block">
            {hoverClock(Date.parse(mark.ts), span)} · {mark.kind} · {mark.title}
          </span>
        </div>
      ))}
      {showLine ? (
        <>
          <span className="pointer-events-none absolute top-0 bottom-0 z-[6] w-px bg-foreground/50" style={{ left: at(hover.ts) }} />
          <span
            className="pointer-events-none absolute top-0 z-[6] ml-1 rounded-sm border border-white/14 bg-popover px-1 font-mono text-2xs leading-[16px] tabular-nums"
            style={{ left: at(hover.ts) }}
          >
            {hoverClock(hover.ts, span)}
          </span>
        </>
      ) : null}
    </div>
  );
}
