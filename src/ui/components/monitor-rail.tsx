import { X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatOpenFor } from "../../shared/monitor";
import type { MonitorView } from "@/types";
import { callHost, clockAt, laneReadout, opensWhen, remindLabel, sourceOf } from "@/watch";

const btn2 = "flex h-7 items-center rounded-md border px-3 text-[13px] hover:bg-accent";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground">{k}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </>
  );
}

/** "failed 503 ×2": what its last calls came back with, when they did not go through. */
function callFailure(m: MonitorView): string | null {
  if ((m.consecutive_failures ?? 0) < 1) {
    return null;
  }
  const status = m.last_status ?? "error";
  return m.consecutive_failures === 1 ? `failed ${status}` : `failed ${status} ×${m.consecutive_failures}`;
}

/** Frame 18i: a monitor read beside the hunt it opened. */
export function MonitorRail({
  monitor,
  nowMs,
  onClose,
  onEdit,
  onPause,
  onSilence,
}: {
  monitor: MonitorView;
  nowMs: number;
  onClose: () => void;
  onEdit: () => void;
  onPause: (paused: boolean) => void;
  onSilence: (forId: "1h" | "4h" | "24h" | null) => void;
}) {
  const fingerprints = sourceOf(monitor) === "fingerprints";
  const readout = laneReadout(monitor, nowMs, 0);
  const open = monitor.state === "open" ? monitor.open : null;
  const reminded = open?.calls.filter((c) => c.what === "reminder" && c.ok).at(-1);
  const silenced = typeof monitor.silenced_until === "number" && monitor.silenced_until > nowMs;
  const paused = monitor.enabled === 0;
  const failure = callFailure(monitor);
  return (
    <aside className="flex w-[330px] max-w-[34%] shrink-0 flex-col gap-3 overflow-y-auto border-l bg-[#0c0c0e] p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold">{monitor.name}</span>
        <span className="inline-flex h-[18px] items-center rounded-[4px] border border-white/[0.18] px-1.5 text-[10.5px] text-muted-foreground">
          {fingerprints ? "fingerprints" : "search"}
        </span>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10.5px] whitespace-nowrap",
            readout.tone === "red" ? "bg-red-500/[0.16] text-red-300" : "bg-[#27272a] text-zinc-300",
          )}
        >
          {open ? `open ${formatOpenFor(nowMs - open.opened_at)}` : readout.badge}
        </span>
        {open ? (
          <span className="font-mono text-[11.5px] text-muted-foreground">
            since {clockAt(open.opened_at, nowMs)}
            {reminded ? ` · reminded ${clockAt(reminded.at, nowMs)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12px]">
        <Row k="search">{monitor.saved?.name ?? "—"}</Row>
        {fingerprints ? (
          <Row k="opens on">
            <span className="font-mono">≥ {monitor.threshold} after a deploy or flag · 24h</span>
          </Row>
        ) : (
          <Row k="opens when">
            <span className="font-mono">
              {opensWhen(monitor)} in {monitor.saved?.range ?? "its window"}
            </span>
          </Row>
        )}
        {!fingerprints && monitor.last_result_at ? (
          <Row k="last read">
            <span className="font-mono">
              {clockAt(monitor.last_result_at, nowMs)} · {readout.text || "—"}
            </span>
          </Row>
        ) : null}
        <Row k="calls">
          <span className="font-mono">
            {callHost(monitor.webhook_url)}
            {fingerprints ? "" : ` · ${remindLabel(monitor)}`}
          </span>
          {failure ? (
            <span className="block font-mono text-red-300" title={monitor.last_error ?? undefined}>
              {failure}
            </span>
          ) : null}
        </Row>
        {silenced ? (
          <Row k="silenced">
            <span className="font-mono">until {clockAt(monitor.silenced_until!, nowMs)}</span>
          </Row>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={btn2} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={btn2} onClick={() => onPause(!paused)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={btn2}>
              Silence
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(["1h", "4h", "24h"] as const).map((id) => (
              <DropdownMenuItem key={id} onSelect={() => onSilence(id)}>
                {id === "1h" ? "1 hour" : id === "4h" ? "4 hours" : "24 hours"}
              </DropdownMenuItem>
            ))}
            {silenced ? <DropdownMenuItem onSelect={() => onSilence(null)}>Clear silence</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
