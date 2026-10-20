import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isTypingTarget } from "@/keyboard";
import { cn } from "@/lib/utils";
import { formatChangeMarkLabel, type ChangeMark } from "../../shared/change-mark";
import { formatOpenFor } from "../../shared/monitor";
import type { MonitorStretch, MonitorView } from "@/types";
import {
  callHost,
  callLine,
  clockAt,
  clockFrac,
  markBefore,
  nextReminder,
  opensWhen,
  sourceOf,
  stretchSpans,
} from "@/watch";

/** The stretches of the monitors on this hunt's saved search (#175, frame 18o). */
export type MonitorBand = {
  items: Array<{ stretch: MonitorStretch; monitor: MonitorView }>;
  nowMs: number;
  /** The monitor beside this tab (18i). */
  onOpenMonitor: (monitor: MonitorView) => void;
  onSilence: (monitor: MonitorView, forId: "1h" | "4h" | "24h") => void;
};

/** The lane grows by this much when it carries stretches: marks above, stretches under them. */
export const MONITOR_BAND_H = 8;

export function monitorBandH(band: MonitorBand | null | undefined): number {
  return band && band.items.length > 0 ? MONITOR_BAND_H : 0;
}

const btn2 = "flex h-[26px] items-center rounded-md border px-2.5 text-[12px] hover:bg-accent";

/** "opened 10:41 · at least 50 lines in 15m". */
function openedLine(monitor: MonitorView, stretch: MonitorStretch, nowMs: number): string {
  const what =
    sourceOf(monitor) === "fingerprints"
      ? "new fingerprints"
      : monitor.saved?.agg
        ? `${opensWhen(monitor)} in ${monitor.saved?.range ?? "its window"}`
        : `at least ${monitor.threshold} line${monitor.threshold === 1 ? "" : "s"} in ${monitor.saved?.range ?? "its window"}`;
  if (stretch.resolved_at === null) {
    return `opened ${clockAt(stretch.opened_at, nowMs)} · ${what}`;
  }
  return `opened ${clockAt(stretch.opened_at, nowMs)} · resolved ${clockAt(stretch.resolved_at, nowMs)}${
    stretch.closed_by === "edit" ? " by an edit" : ""
  }`;
}

function StretchCard({
  monitor,
  stretch,
  band,
  marks,
  before,
  left,
  onFingerprints,
  onCompare,
  onClose,
}: {
  monitor: MonitorView;
  stretch: MonitorStretch;
  band: MonitorBand;
  marks: ChangeMark[];
  before: ChangeMark | null;
  left: number;
  onFingerprints?: (mark: ChangeMark) => void;
  onCompare?: (mark: ChangeMark) => void;
  onClose: () => void;
}) {
  const nowMs = band.nowMs;
  const open = stretch.resolved_at === null;
  const mark = markBefore(marks, before, stretch.opened_at);
  const host = callHost(monitor.webhook_url);
  const next = open && monitor.open?.id === stretch.id ? nextReminder(monitor, nowMs) : null;
  return (
    <div
      role="dialog"
      aria-label={`${monitor.name} · stretch`}
      className="absolute z-[9] flex w-[340px] flex-col gap-2 rounded-[6.4px] border bg-[#1f1f23] p-3 shadow-[0_10px_30px_rgba(0,0,0,.55)]"
      style={{
        top: "100%",
        marginTop: 4,
        left: `${(left * 100).toFixed(3)}%`,
        transform: left > 0.55 ? "translateX(-100%)" : undefined,
      }}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold">{monitor.name}</span>
        <span
          className={cn(
            "inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 text-[10.5px] whitespace-nowrap",
            open ? "bg-red-500/[0.16] text-red-300" : "bg-[#27272a] text-zinc-300",
          )}
        >
          open {formatOpenFor((stretch.resolved_at ?? nowMs) - stretch.opened_at)}
        </span>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </span>
      <span className="font-mono text-[11.5px] text-muted-foreground">{openedLine(monitor, stretch, nowMs)}</span>
      <span className="flex flex-col gap-[3px] rounded-[6px] bg-[#0f0f11] p-2 text-[12px]">
        <span className="font-mono">
          <span className="text-muted-foreground">opened on</span> {stretch.open_message || "—"}
        </span>
        {mark ? (
          <span className="font-mono">
            <span className="text-muted-foreground">before it</span> ▲ {formatChangeMarkLabel(mark)} ·{" "}
            {mark.ts.slice(11, 19)}
          </span>
        ) : null}
      </span>
      {stretch.calls.length > 0 || next !== null ? (
        <span className="flex flex-col gap-[3px] text-[12px]">
          {stretch.calls.map((call) => (
            <span key={call.id} className={cn("font-mono", !call.ok && call.status !== "silenced" && "text-red-300")}>
              {callLine(call, host, nowMs)}
            </span>
          ))}
          {next !== null ? (
            <span className="font-mono text-muted-foreground">{clockAt(next, nowMs)} reminder, if still open</span>
          ) : null}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-1.5">
        {mark && onFingerprints ? (
          <button type="button" className={btn2} onClick={() => onFingerprints(mark)}>
            Fingerprints
          </button>
        ) : null}
        {mark && onCompare ? (
          <button type="button" className={btn2} onClick={() => onCompare(mark)}>
            Compare
          </button>
        ) : null}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={btn2}>
              Silence
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(["1h", "4h", "24h"] as const).map((id) => (
              <DropdownMenuItem key={id} onSelect={() => band.onSilence(monitor, id)}>
                {id === "1h" ? "1 hour" : id === "4h" ? "4 hours" : "24 hours"}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className={btn2}
          onClick={() => {
            band.onOpenMonitor(monitor);
            onClose();
          }}
        >
          Monitor
        </button>
      </span>
    </div>
  );
}

/**
 * Under the marks on the hunt clock, each stretch of a monitor on this saved search: dim once
 * resolved, red and ringed while open. A click reads it (18o).
 */
export function MonitorBandRow({
  band,
  fromMs,
  plotSpanMs,
  slidePct,
  marks,
  before,
  onFingerprints,
  onCompare,
}: {
  band: MonitorBand;
  fromMs: number;
  plotSpanMs: number;
  slidePct: number | null;
  marks: ChangeMark[];
  before: ChangeMark | null;
  onFingerprints?: (mark: ChangeMark) => void;
  onCompare?: (mark: ChangeMark) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toMs = fromMs + plotSpanMs;
  const spans = stretchSpans(
    band.items.map((item) => item.stretch),
    fromMs,
    toMs,
    band.nowMs,
  );
  const byId = new Map(band.items.map((item) => [item.stretch.id, item]));
  const picked = openId ? byId.get(openId) : undefined;

  useEffect(() => {
    if (!openId) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpenId(null);
      }
    }
    function onDown(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element) || rootRef.current?.contains(target)) {
        return;
      }
      // The Silence menu is portalled out of the card.
      if (target.closest("[data-radix-popper-content-wrapper]")) {
        return;
      }
      setOpenId(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [openId]);

  return (
    <div ref={rootRef} className="absolute inset-x-1 bottom-0" style={{ height: MONITOR_BAND_H + 2 }}>
      <div
        className="absolute inset-0"
        style={slidePct != null ? { transform: `translateX(${slidePct.toFixed(3)}%)` } : undefined}
      >
        {spans.map((span) => {
          const item = byId.get(span.id)!;
          const end = span.stretch.resolved_at ?? band.nowMs;
          const label = `open ${formatOpenFor(end - span.stretch.opened_at)}`;
          return (
            <span key={span.id}>
              <button
                type="button"
                aria-label={`${item.monitor.name} ${label}`}
                className={cn(
                  "absolute top-0 h-2",
                  span.open
                    ? "rounded-l-[2px] bg-red-500 outline-2 outline-offset-1 outline-plate"
                    : "rounded-[2px] bg-red-500/35",
                )}
                style={{ left: `${(span.left * 100).toFixed(3)}%`, width: `${(span.width * 100).toFixed(3)}%` }}
                onClick={() => setOpenId((prev) => (prev === span.id ? null : span.id))}
              />
              {span.width > 0.08 && !span.open ? (
                <span
                  className="pointer-events-none absolute -top-[2px] font-mono text-[10.5px] leading-3 text-red-300"
                  style={{ left: `calc(${(span.left * 100).toFixed(3)}% + 6px)` }}
                >
                  {label}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
      {picked ? (
        <StretchCard
          monitor={picked.monitor}
          stretch={picked.stretch}
          band={band}
          marks={marks}
          before={before}
          left={Math.max(0, Math.min(1, clockFrac(picked.stretch.opened_at, fromMs, toMs)))}
          onFingerprints={
            onFingerprints
              ? (mark) => {
                  onFingerprints(mark);
                  setOpenId(null);
                }
              : undefined
          }
          onCompare={
            onCompare
              ? (mark) => {
                  onCompare(mark);
                  setOpenId(null);
                }
              : undefined
          }
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
