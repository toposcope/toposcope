import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatOpenFor } from "../../shared/monitor";
import { formatSpan, maskKey } from "../../shared/push";
import { formatCompactCount } from "@/count-format";
import { formatAggStat } from "@/fill-histogram";
import type { MonitorPage, MonitorView } from "@/types";
import { Badge } from "@/components/watch-view";
import {
  callHost,
  cantTellNow,
  clockAt,
  lastLineWords,
  laneReadout,
  opensWhen,
  readsQuiet,
  remindLabel,
  sourceOf,
} from "@/watch";

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

/** What it last read: its value, or why it could not tell. */
function lastReading(m: MonitorView): string {
  if (m.last_status === "refused" || m.last_status === "error") {
    return m.last_status;
  }
  if (typeof m.last_value !== "number") {
    return "—";
  }
  return m.saved?.agg ? formatAggStat(m.last_value) : formatCompactCount(m.last_value);
}

/**
 * A push monitor's own rows (18i): its keyed URL, which only its page prints, its schedule, its
 * last ok and who it calls.
 */
function PushRows({ monitor, nowMs }: { monitor: MonitorView; nowMs: number }) {
  const [key, setKey] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    void fetch(`/api/monitors/${encodeURIComponent(monitor.name)}`)
      .then((res) => (res.ok ? (res.json() as Promise<MonitorPage>) : null))
      .then((page) => {
        if (!stop) {
          setKey(page?.ping_key ?? null);
        }
      })
      .catch(() => undefined);
    if (!monitor.webhook_url) {
      void fetch("/api/settings")
        .then((res) => (res.ok ? (res.json() as Promise<{ default_webhook_url?: string | null }>) : null))
        .then((json) => {
          if (!stop) {
            setFallback(json?.default_webhook_url ?? null);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      stop = true;
    };
  }, [monitor.name, monitor.webhook_url]);
  const every = monitor.every_ms ?? null;
  const url = key ? `${window.location.origin}/ping/${key}` : null;
  const failure = callFailure(monitor);
  return (
    <>
      <Row k="keyed URL">
        <span className="font-mono">{key ? `/ping/${maskKey(key)}` : "—"}</span>
        {url ? (
          <button
            type="button"
            className="ml-2 hover:underline"
            onClick={() =>
              void navigator.clipboard.writeText(url).then(
                () => toast.success("Keyed URL copied"),
                () => toast.error("Copy failed"),
              )
            }
          >
            Copy
          </button>
        ) : null}
      </Row>
      <Row k="every">
        <span className="font-mono">
          {every === null
            ? "by its results"
            : `${formatSpan(every)}, grace ${formatSpan(monitor.grace_ms ?? Math.min(every, 60 * 60_000))}`}
        </span>
      </Row>
      <Row k="last ok">
        <span className="font-mono">{monitor.last_ok_at ? clockAt(monitor.last_ok_at, nowMs) : "—"}</span>
      </Row>
      <Row k="calls">
        <span className="font-mono">
          {monitor.webhook_url ? callHost(monitor.webhook_url) : fallback ? `default · ${callHost(fallback)}` : "nobody"}
          {` · ${remindLabel(monitor)}`}
        </span>
        {failure ? (
          <span className="block font-mono text-red-300" title={monitor.last_error ?? undefined}>
            {failure}
          </span>
        ) : null}
      </Row>
    </>
  );
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
  const push = sourceOf(monitor) === "push";
  const readout = laneReadout(monitor, nowMs, 0);
  const open = monitor.state === "open" ? monitor.open : null;
  const reminded = open?.calls.filter((c) => c.what === "reminder" && c.ok).at(-1);
  const silenced = typeof monitor.silenced_until === "number" && monitor.silenced_until > nowMs;
  const paused = monitor.enabled === 0;
  const failure = callFailure(monitor);
  const quiet = readsQuiet(monitor);
  const cantTell = cantTellNow(monitor, nowMs);
  return (
    <aside className="flex w-[330px] max-w-[34%] shrink-0 flex-col gap-3 overflow-y-auto border-l bg-[#0c0c0e] p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold">{monitor.name}</span>
        <span className="inline-flex h-[18px] items-center rounded-[4px] border border-white/[0.18] px-1.5 text-[10.5px] text-muted-foreground">
          {sourceOf(monitor)}
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
        <Badge tone={open ? "red" : readout.tone}>
          {open ? `open ${formatOpenFor(nowMs - open.opened_at)}` : readout.badge}
        </Badge>
        {open ? (
          <span className="font-mono text-[11.5px] text-muted-foreground">
            since {clockAt(open.opened_at, nowMs)}
            {reminded ? ` · reminded ${clockAt(reminded.at, nowMs)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12px]">
        {push ? <PushRows monitor={monitor} nowMs={nowMs} /> : null}
        {push ? null : <Row k="search">{monitor.saved?.name ?? "—"}</Row>}
        {push ? null : fingerprints ? (
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
        {quiet ? (
          <Row k="last line">
            <span className="font-mono">{lastLineWords(monitor.last_line_at, nowMs)}</span>
          </Row>
        ) : null}
        {cantTell ? (
          <Row k="can't tell">
            <span className="font-mono">{cantTell}</span>
          </Row>
        ) : null}
        {!fingerprints && !push && monitor.last_result_at ? (
          <Row k="last read">
            <span className="font-mono">
              {clockAt(monitor.last_result_at, nowMs)} · {lastReading(monitor)}
            </span>
          </Row>
        ) : null}
        {push ? null : (
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
        )}
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
