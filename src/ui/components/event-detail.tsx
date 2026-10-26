import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChangeMark, ChangeMarkKind } from "../../shared/change-mark";
import { MarkGlyph } from "./histogram-marks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatEventClock, useTimestampFormat } from "@/event-time";
import { levelVariant } from "@/level";
import type { FieldRole } from "../../shared/fields";
import { canFollowField, joinTraceRef } from "../../shared/ids";
import { formatFieldToken } from "../query-tokens";
import type { LogEvent } from "@/types";

const notFilterable = new Set(["ts", "message"]);

type Props = {
  event: LogEvent;
  onClose: () => void;
  onFilter: (field: string, value: string) => void;
  onAround: (event: LogEvent) => void;
  onTrace?: (event: LogEvent) => void;
  links?: Record<string, string>;
  roles?: Record<string, FieldRole>;
  metricNames?: string[];
  onGraph?: (field: string, value: string, metric: string) => void;
  /** Resolves once the Follow tab has opened (its window is read first). */
  onFollow?: (field: string, value: string, ts: string) => Promise<void> | void;
  aroundDisabled?: boolean;
  aroundTitle?: string;
  followDisabled?: boolean;
  followCapTitle?: string;
  existingFollow?: (key: string, value: string) => boolean;
  filterDisabled?: boolean;
  filterTitle?: string;
  hideClose?: boolean;
  closeTitle?: string;
  /** Back to the cut (with its mark's glyph), or `forward` to a span still selected. */
  crumb?: {
    kind?: ChangeMarkKind;
    label: string;
    title?: string;
    forward?: boolean;
    onBack: () => void;
  } | null;
  className?: string;
  fromMs: number;
  spanMs: number;
  /** The marks on the clock (#261): the fingerprint line says which one came before first seen. */
  marks?: ChangeMark[];
  /** Opens the Fingerprints cut for the mark before first seen. */
  onFingerprints?: (mark: ChangeMark) => void;
};

type Field = { k: string; v: string };

function attrValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function fieldsOf(event: LogEvent): Field[] {
  const fields: Field[] = [
    { k: "ts", v: event.ts },
    { k: "level", v: event.level },
    { k: "service", v: event.service },
    { k: "host", v: event.host ?? "" },
    { k: "message", v: event.message },
  ];
  for (const [k, v] of Object.entries(event.attrs ?? {})) {
    fields.push({ k, v: attrValue(v) });
  }
  return fields.filter((field) => field.v !== "");
}

export function EventDetail({
  event,
  onClose,
  onFilter,
  onAround,
  onTrace,
  links = {},
  roles = {},
  metricNames = [],
  onGraph,
  onFollow,
  aroundDisabled = false,
  aroundTitle,
  followDisabled = false,
  followCapTitle,
  existingFollow,
  filterDisabled = false,
  filterTitle,
  hideClose = false,
  closeTitle,
  crumb,
  className,
  fromMs,
  spanMs,
  marks = [],
  onFingerprints,
}: Props) {
  const [tab, setTab] = useState<"fields" | "json" | "stack">("fields");
  const stack = stackOf(event);
  const fp = typeof event.attrs?.e1 === "string" ? (event.attrs.e1 as string) : null;
  const seen = useFingerprintSeen(fp);
  const followKey = followKeyOf(event, roles);
  const json = JSON.stringify(event, null, 2);
  const traceRef = joinTraceRef(event.attrs);
  const format = useTimestampFormat();
  useEffect(() => {
    if (tab === "stack" && !stack) {
      setTab("fields");
    }
  }, [tab, stack]);

  return (
    <aside
      className={cn(
        "my-2 mr-3 ml-1 flex w-[560px] max-w-[40%] shrink-0 flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#121214]",
        className,
      )}
    >
      {crumb ? (
        <button
          type="button"
          title={
            crumb.title ??
            "Back to the cut, exactly as left — nothing recomputes"
          }
          className="flex w-full shrink-0 items-center gap-1.5 border-b bg-[oklch(0.141_0.005_285.823/60%)] px-2.5 py-[5px] text-left hover:bg-[oklch(0.274_0.006_286.033/60%)]"
          onClick={crumb.onBack}
        >
          {crumb.forward ? null : (
            <span className="text-[12px] text-[oklch(0.906_0.014_84)]">‹</span>
          )}
          {crumb.kind ? <MarkGlyph kind={crumb.kind} size={10} /> : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground",
              crumb.forward && "text-right",
            )}
          >
            {crumb.label}
          </span>
          {crumb.forward ? (
            <span className="text-[12px] text-[oklch(0.906_0.014_84)]">›</span>
          ) : null}
        </button>
      ) : null}
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <Badge variant={levelVariant(event.level)}>{event.level}</Badge>
        <span className="truncate font-mono text-[12.5px] text-foreground" title={event.ts}>
          {formatEventClock(event.ts, {
            format,
            fromMs,
            spanMs,
            precision: "ms",
          })}
        </span>
        <span className="truncate font-mono text-[12px] text-muted-foreground">
          {[event.service, event.host].filter(Boolean).join(" · ")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {hideClose ? null : (
            <Button type="button" size="icon" variant="ghost" title={closeTitle ?? "Close · Esc"} aria-label="Close the event" onClick={onClose}>
              <X />
            </Button>
          )}
        </div>
      </div>
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-3 font-mono text-[13px] leading-[1.5] break-words text-foreground">
        {event.message}
      </div>
      {fp ? (
        <FingerprintLine
          hex={fp}
          seen={seen}
          marks={marks}
          onFingerprints={onFingerprints}
        />
      ) : null}
      <div className="flex shrink-0 gap-4 px-4 pt-2.5 text-[12.5px]" role="tablist">
        {(["fields", "json", ...(stack ? (["stack"] as const) : [])] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={cn("border-b-2 pb-1.5", tab === t ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            onClick={() => setTab(t)}
          >
            {t === "fields" ? "Fields" : t === "json" ? "JSON" : "Stack"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "json" ? (
          <pre className="m-3 rounded-lg border bg-background/60 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {json}
          </pre>
        ) : tab === "stack" && stack ? (
          <pre className="m-3 rounded-lg border bg-background/60 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-300">
            {stack}
          </pre>
        ) : (
          <dl className="m-3 overflow-hidden rounded-lg border">
            {fieldsOf(event).map((field) => (
              // At least 28px, and as tall as the value: a value that wraps
              // pushes the rows under it down. The key and the icons stay on
              // the value's first line; a one-line row is laid out as before.
              <div
                key={field.k}
                className="group grid min-h-7 grid-cols-[96px_minmax(0,1fr)_auto] items-start gap-2 border-b border-white/[0.08] px-2.5 pt-1.5 pb-[5px] last:border-0"
              >
                <dt className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
                  {field.k}
                </dt>
                <dd className="font-mono text-xs break-words">{field.v}</dd>
                <div className="-my-[3px] flex items-center justify-end gap-0.5">
                  {links[field.k] && onGraph ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="h-[22px] rounded-[4px] px-1.5 text-[11.5px] text-plate hover:bg-accent"
                          title={`Graph ${field.k}:${field.v}`}
                          aria-label={`Graph ${field.k}`}
                        >
                          graph
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[8rem] p-1">
                        {metricNames.length === 0 ? (
                          <DropdownMenuItem disabled>No metrics</DropdownMenuItem>
                        ) : (
                          metricNames.map((name) => (
                            <DropdownMenuItem
                              key={name}
                              onSelect={() => onGraph(field.k, field.v, name)}
                            >
                              {name}
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  {canFollowField(field.k, field.v, roles[field.k]) && onFollow ? (
                    <FollowFieldButton
                      field={field.k}
                      value={field.v}
                      disabled={
                        followDisabled && !existingFollow?.(field.k, field.v)
                      }
                      disabledTitle={followCapTitle}
                      onFollow={() => onFollow(field.k, field.v, event.ts)}
                    />
                  ) : null}
                  {notFilterable.has(field.k) ? null : (
                    <button
                      type="button"
                      className="h-[22px] rounded-[4px] px-1.5 text-[11.5px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-40"
                      title={
                        filterDisabled
                          ? filterTitle
                          : `Filter ${field.k}:${field.v}`
                      }
                      disabled={filterDisabled}
                      onClick={() => onFilter(field.k, field.v)}
                    >
                      + filter
                    </button>
                  )}
                </div>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[12.5px]"
          title={aroundTitle ?? "The rows around this one, on the same service and host"}
          disabled={aroundDisabled}
          onClick={() => onAround(event)}
        >
          Surroundings
        </Button>
        {traceRef && onTrace ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[12.5px]"
            title={`Where time went in this request — joined on ${traceRef.key}:${traceRef.value}`}
            onClick={() => onTrace(event)}
          >
            Trace <span className="font-mono">{shortId(traceRef.value)}</span>
          </Button>
        ) : null}
        {followKey && onFollow ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[12.5px]"
            disabled={followDisabled && !existingFollow?.(followKey.k, followKey.v)}
            title={followDisabled ? followCapTitle : `Follow ${formatFieldToken(followKey.k, followKey.v)} — every service, first to last seen within a day`}
            onClick={() => void onFollow(followKey.k, followKey.v, event.ts)}
          >
            Follow <span className="font-mono">{followKey.k}</span>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-[12.5px] text-muted-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(json);
            toast.success("JSON copied");
          }}
        >
          Copy JSON
        </Button>
      </div>
    </aside>
  );
}

function FollowFieldButton({
  field,
  value,
  disabled,
  disabledTitle,
  onFollow,
}: {
  field: string;
  value: string;
  disabled?: boolean;
  disabledTitle?: string;
  onFollow: () => Promise<void> | void;
}) {
  const token = formatFieldToken(field, value);
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  async function follow() {
    setFinding(true);
    try {
      await onFollow();
    } finally {
      setFinding(false);
      setOpen(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-[22px] rounded-[4px] px-1.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={
            disabled
              ? disabledTitle
              : `Follow ${token} — every service, first to last seen within a day`
          }
          aria-label="Follow this value"
          disabled={disabled}
        >
          follow
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] bg-[#18181b] p-2">
        <div className="px-1.5 pb-1.5">
          <div className="text-[12.5px] font-medium">Follow this value</div>
          <div className="mt-0.5 font-mono text-[12px] break-all">{token}</div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            First to last seen, within a day of this event · every service
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            Opens a new tab · this one stays as it is.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-7 w-full text-[12.5px]"
          disabled={disabled || finding}
          title={disabled ? disabledTitle : undefined}
          onClick={() => void follow()}
        >
          {finding ? "Finding first and last seen…" : "Follow"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** A row's stack, when its exception carries one (Stack tab, 26e). */
export function stackOf(event: LogEvent): string | null {
  const raw = event.attrs?.["exception.stacktrace"];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/** "8b3f…e1": a trace id short enough for a button. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id;
}

/** The footer's Follow: the first id-shaped attr on the row a hunt would follow (request_id, …). */
export function followKeyOf(event: LogEvent, roles: Record<string, FieldRole>): Field | null {
  const attrs = Object.entries(event.attrs ?? {}).map(([k, v]) => ({ k, v: attrValue(v) }));
  // A trace id has its own button (Trace …); a fingerprint has its own line.
  const ok = (f: Field) => f.k !== "e1" && !/(^|[._])(trace|span)_?id$/i.test(f.k) && canFollowField(f.k, f.v, roles[f.k]);
  return attrs.find((f) => ok(f) && (roles[f.k] === "lookup" || /(^|[._])(request|req|order|session|job)_?id$/i.test(f.k))) ?? null;
}

type Seen = { first_ts: string | null; count: number; hosts: number } | null;

/** When this fingerprint was first seen in the last 7 days, and how often (`GET /api/fingerprints/:hex`). */
function useFingerprintSeen(hex: string | null): Seen {
  const [seen, setSeen] = useState<Seen>(null);
  useEffect(() => {
    setSeen(null);
    if (!hex) {
      return;
    }
    const ac = new AbortController();
    void fetch(`/api/fingerprints/${encodeURIComponent(hex)}`, { signal: ac.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setSeen(body as Seen))
      .catch(() => undefined);
    return () => ac.abort();
  }, [hex]);
  return seen;
}

/** The mark just before first seen, within an hour: "1 min after ▲ billing v0.9". */
export function markBeforeFirstSeen(firstTs: string | null, marks: ChangeMark[]): { mark: ChangeMark; minutes: number } | null {
  if (!firstTs) {
    return null;
  }
  const t = Date.parse(firstTs);
  const before = marks
    .filter((m) => Date.parse(m.ts) <= t && t - Date.parse(m.ts) <= 60 * 60_000 && m.kind !== "note")
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  return before ? { mark: before, minutes: Math.round((t - Date.parse(before.ts)) / 60_000) } : null;
}

function FingerprintLine({ hex, seen, marks, onFingerprints }: { hex: string; seen: Seen; marks: ChangeMark[]; onFingerprints?: (mark: ChangeMark) => void }) {
  const after = markBeforeFirstSeen(seen?.first_ts ?? null, marks);
  const first = seen?.first_ts ? new Date(seen.first_ts).toISOString().slice(11, 16) : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-white/[0.06] px-4 py-2.5 text-[12.5px]">
      <span className="font-mono text-plate">e1:{hex}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {seen === null
          ? "reading when it was first seen…"
          : seen.count === 0
            ? "not seen in the last 7 days"
            : [
                `first seen ${first}${after ? `, ${after.minutes} min after ${after.mark.kind === "deploy" ? "▲" : after.mark.kind === "flag" ? "⚑" : "◆"} ${after.mark.title}` : ""}`,
                `${seen.count.toLocaleString("en-US")} in 7 d`,
                `${seen.hosts} host${seen.hosts === 1 ? "" : "s"}`,
              ].join(" · ")}
      </span>
      {after && onFingerprints ? (
        <button type="button" className="text-plate hover:text-white" onClick={() => onFingerprints(after.mark)}>
          Fingerprints →
        </button>
      ) : null}
    </div>
  );
}
