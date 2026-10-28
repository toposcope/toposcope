import { useState, type ReactNode } from "react";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HeldSource } from "../../shared/held";
import type { Span } from "../../shared/span";
import { enteredRow, showsEntered } from "../trace-held";
import { formatTraceMs } from "../waterfall";
import {
  foldStack,
  resourcePreview,
  spanFieldGroups,
  spanJson,
  spanOffsetLabel,
  type SpanField,
} from "../span-fields";

/** Resource rows shown before "Show N more". */
const resourceShown = 8;

type Props = {
  span: Span;
  /** From the trace's start, for `+100ms`. */
  startMs: number;
  crumb?: { label: string; title?: string; onBack: () => void } | null;
  onClose: () => void;
  onViewProfiles: (span: Span) => void;
  className?: string;
  /** What this instance holds (#139, #330), for "Where it entered". */
  held?: { sources: HeldSource[]; now: number; here: string };
};

function GroupHead({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "mx-3 mt-3 mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase",
        tone === "error" ? "text-red-400" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function Row({ field, wideKey = false }: { field: SpanField; wideKey?: boolean }) {
  return (
    <div
      className={cn(
        "grid min-h-7 items-start gap-2 border-b border-white/[0.08] px-2.5 pt-1.5 pb-[5px] last:border-0",
        wideKey
          ? "grid-cols-[136px_minmax(0,1fr)] @max-[300px]:grid-cols-[100px_minmax(0,1fr)]"
          : "grid-cols-[104px_minmax(0,1fr)] @max-[300px]:grid-cols-[76px_minmax(0,1fr)]",
      )}
    >
      <dt className="truncate font-mono text-[11px] leading-4 text-muted-foreground" title={field.k}>
        {field.k}
      </dt>
      <dd className="font-mono text-xs break-words whitespace-pre-wrap">{field.v}</dd>
    </div>
  );
}

/** The stack whole, line by line; past 20 lines its middle folds and both ends stay. */
function StackRow({ stack }: { stack: string }) {
  const fold = foldStack(stack);
  const [open, setOpen] = useState(false);
  const folded = fold.hidden !== null && !open;
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-2 border-b border-white/[0.08] px-2.5 pt-1.5 pb-2 last:border-0 @max-[340px]:grid-cols-1 @max-[340px]:gap-1">
      <dt className="flex min-w-0 flex-col gap-0.5 font-mono text-[11px] leading-4 text-muted-foreground @max-[340px]:flex-row @max-[340px]:items-center @max-[340px]:gap-2">
        <span>stacktrace</span>
        {fold.hidden ? (
          <span className="flex items-center gap-1 font-sans text-[11px] text-muted-foreground/80">
            {fold.lines} lines
            <button
              type="button"
              className="inline-flex size-[22px] items-center justify-center rounded-[4.4px] hover:bg-accent hover:text-foreground"
              title="Copy the stack trace"
              aria-label="Copy the stack trace"
              onClick={() => {
                void navigator.clipboard.writeText(stack);
                toast.success("Stack trace copied");
              }}
            >
              <Copy className="size-3.5" />
            </button>
          </span>
        ) : null}
      </dt>
      <dd className="min-w-0 font-mono text-xs leading-[1.45] break-words whitespace-pre-wrap">
        {fold.hidden === null ? (
          fold.head
        ) : (
          <>
            <div>{fold.head}</div>
            {folded ? (
              <button
                type="button"
                className="my-1.5 block w-full rounded-[4.4px] border border-dashed border-white/20 px-2 py-1 text-left font-sans text-[12px] text-foreground hover:bg-accent"
                onClick={() => setOpen(true)}
              >
                Show {fold.hidden.count} hidden lines
              </button>
            ) : (
              <div>{fold.hidden.text}</div>
            )}
            <div>{fold.tail}</div>
          </>
        )}
      </dd>
    </div>
  );
}

function ResourceGroup({ fields }: { fields: SpanField[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? fields : fields.slice(0, resourceShown);
  return (
    <div className="mx-3 mt-3 overflow-hidden rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03]"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[9px] text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Resource · {fields.length}
        </span>
        {open ? null : (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 @max-[340px]:hidden">
            {resourcePreview(fields)}
          </span>
        )}
      </button>
      {open ? (
        <dl className="border-t border-white/[0.08]">
          {shown.map((field) => (
            <Row key={field.k} field={field} wideKey />
          ))}
          {fields.length > shown.length ? (
            <button
              type="button"
              className="w-full px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"
              onClick={() => setAll(true)}
            >
              Show {fields.length - shown.length} more
            </button>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/** A selected span in the rail, laid out as an event is: one attribute a row. */
export function SpanDetail({ span, startMs, crumb, onClose, onViewProfiles, className, held }: Props) {
  const [tab, setTab] = useState<"fields" | "json">("fields");
  const groups = spanFieldGroups(span);
  const json = spanJson(span);
  const offset = spanOffsetLabel(startMs, formatTraceMs);
  const sources = held?.sources ?? [];
  const entered = showsEntered(span, sources)
    ? enteredRow(span, sources, held?.now ?? Date.now(), held?.here ?? "")
    : null;
  return (
    <aside
      data-screen-label="Span detail"
      className={cn(
        "@container flex w-[376px] max-w-[34%] shrink-0 flex-col border-l bg-[#0f0f11]",
        className,
      )}
    >
      {crumb ? (
        <button
          type="button"
          title={crumb.title}
          className="flex w-full shrink-0 items-center gap-1.5 border-b bg-[oklch(0.141_0.005_285.823/60%)] px-2.5 py-[5px] text-left hover:bg-[oklch(0.274_0.006_286.033/60%)]"
          onClick={crumb.onBack}
        >
          <span className="text-[12px] text-[oklch(0.906_0.014_84)]">‹</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
            {crumb.label}
          </span>
        </button>
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
        <span className="shrink-0 rounded-[3px] bg-white/10 px-1.5 py-px text-[10px] font-semibold tracking-[0.06em]">
          SPAN
        </span>
        <span className="min-w-0 truncate font-mono text-xs" title={`${span.service} · ${span.name}`}>
          {span.service} · {span.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground @max-[340px]:hidden">
          {formatTraceMs(span.duration_ms)}
          {offset ? ` · ${offset}` : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Copy the span as JSON"
            aria-label="Copy the span as JSON"
            onClick={() => {
              void navigator.clipboard.writeText(json);
              toast.success("Span copied as JSON");
            }}
          >
            <Copy />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Clear the selected span"
            aria-label="Clear the selected span"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5 border-b px-2 py-1">
        <Button
          type="button"
          size="sm"
          variant={tab === "fields" ? "secondary" : "ghost"}
          onClick={() => setTab("fields")}
        >
          Fields
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "json" ? "secondary" : "ghost"}
          onClick={() => setTab("json")}
        >
          JSON
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-3">
        {tab === "json" ? (
          <pre className="m-3 rounded-lg border bg-background/60 p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {json}
          </pre>
        ) : (
          <>
            {entered ? (
              <>
                <GroupHead>Where it entered</GroupHead>
                <dl className="mx-3 overflow-hidden rounded-lg border">
                  <div className="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] items-start gap-2 px-2.5 pt-1.5 pb-[5px] @max-[300px]:grid-cols-[76px_minmax(0,1fr)]">
                    <dt className="truncate font-mono text-[11px] leading-4 text-muted-foreground">toposcope</dt>
                    <dd className="font-mono text-xs break-words">
                      {entered.value}
                      {entered.note ? <span className="font-sans text-muted-foreground"> · {entered.note}</span> : null}
                    </dd>
                  </div>
                </dl>
              </>
            ) : null}
            {groups.exception ? (
              <>
                <GroupHead tone="error">Exception</GroupHead>
                <dl className="mx-3 overflow-hidden rounded-lg border">
                  {groups.exception.map((field) =>
                    field.k === "stacktrace" ? (
                      <StackRow key={field.k} stack={field.v} />
                    ) : (
                      <Row key={field.k} field={field} />
                    ),
                  )}
                </dl>
              </>
            ) : null}
            {groups.span.length > 0 ? (
              <>
                <GroupHead>Span · {groups.span.length}</GroupHead>
                <dl className="mx-3 overflow-hidden rounded-lg border">
                  {groups.span.map((field) => (
                    <Row key={field.k} field={field} />
                  ))}
                </dl>
              </>
            ) : null}
            {groups.resource.length > 0 ? <ResourceGroup fields={groups.resource} /> : null}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t px-2.5 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[12.5px]"
          title={`Flamegraph of the profile samples linked to this span · span_id:${span.span_id}`}
          onClick={() => onViewProfiles(span)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="0" y="0.5" width="12" height="3" rx="1" />
            <rect x="0" y="4.5" width="8" height="3" rx="1" />
            <rect x="2.5" y="8.5" width="4" height="3" rx="1" />
          </svg>
          View profiles
        </Button>
      </div>
    </aside>
  );
}
