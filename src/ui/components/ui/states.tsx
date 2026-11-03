import * as React from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { liveAgeView, liveUpdatedMinAgeMs } from "../../live-updated";
import { SEARCH_SLOW_AFTER_MS } from "../../time-range";
import { formatDuration } from "../../../shared/duration";

/**
 * Sheet 45, Patterns → Data states: every panel, table and page shows its states the same way.
 * Live polls keep the last paint: they never dim, never skeleton and never show Busy.
 */

/** The last paint while a request runs: half opacity, and no clicks through it. */
export const busyDim = "pointer-events-none opacity-50";

/** The 2px bar under the field a request runs from. Its parent is `relative`. */
export function BusyBar({ className }: { className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-white/[0.06]", className)}>
      <div className="h-full w-1/3 animate-toposcope-indeterminate rounded-full bg-gradient-to-r from-transparent via-primary to-transparent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-35" />
    </div>
  );
}

/** One hint, when a request runs past 5s. */
export const slowHint = "narrow the window or add a service: filter";

/**
 * The in-flight pill: spinner, label and elapsed, then Stop. Past 5s (or `slow`) it turns warn
 * and carries one hint.
 */
export function Busy({
  label = "Searching",
  elapsedMs,
  slow,
  hint = slowHint,
  onStop,
  size = "md",
  className,
}: {
  label?: string;
  elapsedMs: number;
  slow?: boolean;
  hint?: string;
  onStop: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const late = slow ?? elapsedMs >= SEARCH_SLOW_AFTER_MS;
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border py-0 pr-0.5 pl-2.5",
        size === "sm" ? "h-5.5" : "h-6.5",
        late ? "border-warn/45 bg-warn-soft" : "border-input",
        className,
      )}
    >
      <span className="size-[11px] shrink-0 animate-spin rounded-full border-[1.5px] border-white/25 border-t-foreground motion-reduce:animate-[spin_2.4s_linear_infinite]" aria-hidden />
      <span className="shrink-0 text-xs whitespace-nowrap">
        {label}…{elapsedMs >= 100 ? ` ${formatDuration(elapsedMs, "precise")}` : ""}
      </span>
      {late && hint ? <span className="min-w-0 truncate border-l border-white/12 pl-2 text-xs text-warn-fg">{hint}</span> : null}
      <Button size="xs" type="button" variant="ghost" className="shrink-0 px-2 text-xs" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

/**
 * A refused read: always warn, never danger. Inline for a count or a footnote (`—` and one
 * line), block for a table or a panel.
 */
export function Refused({
  reason,
  form = "inline",
  title,
  count = false,
  className,
}: {
  reason: React.ReactNode;
  form?: "inline" | "block";
  /** Block form: a heading over the reason. */
  title?: React.ReactNode;
  /** Inline form: lead with a muted `—` where the count would be. */
  count?: boolean;
  className?: string;
}) {
  if (form === "block") {
    return (
      <div role="status" className={cn("flex flex-col items-center justify-center gap-1.5 px-4 text-center", className)}>
        {title ? <span className="text-base font-medium text-warn-fg">{title}</span> : null}
        <span className={cn("max-w-[44ch] text-sm", title ? "text-muted-foreground" : "text-warn-fg")}>{reason}</span>
      </div>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-2", className)}>
      {count ? <span className="text-muted-foreground">—</span> : null}
      <span className="min-w-0 text-warn-fg">{reason}</span>
    </span>
  );
}

/** Nothing to show: a title, one line, at most one action. The copy says which empty it is. */
export function Empty({
  title,
  line,
  action,
  className,
}: {
  title: React.ReactNode;
  line?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border bg-surface-1 px-4 py-7 text-center", className)}>
      <p className="m-0 text-base font-medium">{title}</p>
      {line ? <p className="m-0 max-w-[44ch] text-sm leading-relaxed text-muted-foreground">{line}</p> : null}
      {action ? <div className="mt-0.5">{action}</div> : null}
    </div>
  );
}

const bone = "rounded-sm bg-white/10";
const pulse = "animate-toposcope-shimmer motion-reduce:animate-none";

/**
 * An empty first paint only: rows (a table or list), bars (a chart) or a block. Not for a
 * re-query or a Live poll, which keep the last paint.
 */
export function Skeleton(
  props:
    | { kind: "block"; className?: string; style?: React.CSSProperties }
    | {
        kind: "rows";
        rows: number;
        /** Each row's bones: a width (`60px`, `38%`) or undefined to fill its cell. */
        cells: (row: number) => Array<string | undefined>;
        className?: string;
        rowClassName?: string;
        rowStyle?: React.CSSProperties;
      }
    | { kind: "bars"; className?: string },
) {
  if (props.kind === "block") {
    return <div aria-hidden className={cn(bone, pulse, props.className)} style={props.style} />;
  }
  if (props.kind === "bars") {
    return (
      <div aria-hidden className={cn("flex min-h-0 flex-1 items-end gap-0.5", pulse, props.className)}>
        {Array.from({ length: 48 }, (_, i) => (
          <span key={i} className="flex-1 rounded-t-sm bg-white/[0.07]" style={{ height: `${28 + ((i * 37) % 52)}%` }} />
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden className={cn(pulse, props.className)}>
      {Array.from({ length: props.rows }, (_, i) => (
        <div key={i} className={props.rowClassName} style={props.rowStyle}>
          {props.cells(i).map((w, j) => (
            <span key={j} className={cn("block h-2", bone)} style={w ? { width: w } : undefined} />
          ))}
        </div>
      ))}
    </div>
  );
}

function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * How old a Live paint is: muted, plate past 35s, the hover text names the cadence. Shown once
 * `minAgeMs` has passed (a missed 2s poll by default); the facet row shows it from the start.
 */
export function LiveAge({
  fetchedAt,
  cadence,
  paused = false,
  minAgeMs = liveUpdatedMinAgeMs,
  tip,
  className,
}: {
  fetchedAt: number | undefined | (() => number | undefined);
  /** What refreshes it, for the hover text: `2s`, `30s`. */
  cadence: string;
  /** Live is paused while an event is open: the age counts on, but is not a missed pass. */
  paused?: boolean;
  minAgeMs?: number;
  /** The hover text, from the age's label; by default it names the cadence. */
  tip?: (label: string) => string;
  className?: string;
}) {
  const now = useNow();
  const view = liveAgeView(typeof fetchedAt === "function" ? fetchedAt() : fetchedAt, now, { minAgeMs, paused });
  if (!view) {
    return null;
  }
  const { label, late } = view;
  const text = tip ? tip(label) : `Refreshes every ${cadence} in Live · last ${label} ago`;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "group inline-flex h-5.5 shrink-0 items-center gap-1 font-mono text-xs tabular-nums",
            late ? "text-plate" : "text-muted-foreground hover:text-foreground",
            className,
          )}
          aria-label={text}
          data-live-age=""
        >
          <RotateCw className="size-3" aria-hidden />
          <span className="decoration-dotted underline-offset-[3px] group-hover:underline">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="border bg-popover px-2 py-1.5 text-sm text-popover-foreground">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A band under the header: the outage (warn) and the way back (ok). */
export function Band({ tone, children, action }: { tone: "warn" | "ok"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex h-9 shrink-0 items-center gap-3 border-b px-5 text-sm",
        tone === "warn" ? "border-warn/30 bg-warn-soft" : "border-ok/30 bg-ok-soft",
      )}
    >
      <span className={cn("size-[7px] shrink-0 rounded-full", tone === "warn" ? "bg-warn" : "bg-ok")} aria-hidden />
      {children}
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}
