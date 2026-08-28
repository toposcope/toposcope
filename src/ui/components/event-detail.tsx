import { useState } from "react";
import { Copy, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChangeMarkKind } from "../../shared/change-mark";
import { MarkGlyph } from "./histogram-marks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatEventClock, useTimestampFormat } from "@/event-time";
import { FollowIcon } from "@/components/follow-icon";
import { levelVariant } from "@/level";
import type { FieldRole } from "../../shared/fields";
import { canFollowField, followScanRole, joinTraceRef } from "../../shared/ids";
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
  onFollow?: (field: string, value: string, ts: string) => void;
  onOpenFields?: () => void;
  aroundDisabled?: boolean;
  aroundTitle?: string;
  followDisabled?: boolean;
  followCapTitle?: string;
  existingFollow?: (key: string, value: string) => boolean;
  filterDisabled?: boolean;
  filterTitle?: string;
  hideClose?: boolean;
  closeTitle?: string;
  crumb?: {
    kind: ChangeMarkKind;
    label: string;
    title?: string;
    onBack: () => void;
  } | null;
  className?: string;
  fromMs: number;
  spanMs: number;
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
  onOpenFields,
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
}: Props) {
  const [tab, setTab] = useState<"fields" | "json">("fields");
  const json = JSON.stringify(event, null, 2);
  const traceRef = joinTraceRef(event.attrs);
  const format = useTimestampFormat();

  return (
    <aside
      className={cn(
        "flex w-[376px] max-w-[34%] shrink-0 flex-col border-l bg-[#0f0f11]",
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
          <span className="text-[12px] text-[oklch(0.906_0.014_84)]">‹</span>
          <MarkGlyph kind={crumb.kind} size={10} />
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
            {crumb.label}
          </span>
        </button>
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
        <Badge variant={levelVariant(event.level)}>{event.level}</Badge>
        <span className="truncate font-mono text-xs text-muted-foreground" title={event.ts}>
          {formatEventClock(event.ts, {
            format,
            fromMs,
            spanMs,
            precision: "ms",
          })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(json);
              toast.success("JSON copied");
            }}
          >
            <Copy />
          </Button>
          {hideClose ? null : (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              title={closeTitle}
              onClick={onClose}
            >
              <X />
            </Button>
          )}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "json" ? (
          <pre className="m-3 rounded-lg border bg-background/60 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {json}
          </pre>
        ) : (
          <dl className="m-3 overflow-hidden rounded-lg border">
            {fieldsOf(event).map((field) => (
              <div
                key={field.k}
                className="group grid h-7 grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-2 border-b border-white/[0.08] px-2.5 last:border-0"
              >
                <dt className="truncate font-mono text-[11px] text-muted-foreground">
                  {field.k}
                </dt>
                <dd className="font-mono text-xs break-words">{field.v}</dd>
                <div className="flex items-center justify-end gap-0.5">
                  {links[field.k] && onGraph ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-[22px]"
                          title={`Graph ${field.k}:${field.v}`}
                          aria-label={`Graph ${field.k}`}
                        >
                          <GraphIcon />
                        </Button>
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
                      role={roles[field.k]}
                      disabled={
                        followDisabled && !existingFollow?.(field.k, field.v)
                      }
                      disabledTitle={followCapTitle}
                      onFollow={() => onFollow(field.k, field.v, event.ts)}
                      onOpenFields={onOpenFields}
                    />
                  ) : null}
                  {notFilterable.has(field.k) ? null : (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-[22px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      title={
                        filterDisabled
                          ? filterTitle
                          : `Filter ${field.k}:${field.v}`
                      }
                      disabled={filterDisabled}
                      onClick={() => onFilter(field.k, field.v)}
                    >
                      <Plus />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t bg-background/45 px-2.5 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[12.5px]"
          title={aroundTitle}
          disabled={aroundDisabled}
          onClick={() => onAround(event)}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          >
            <path d="M4 8h5" />
            <path d="M15 8h5" />
            <path d="M4 16h5" />
            <path d="M15 16h5" />
            <circle cx="12" cy="12" r="2.4" />
          </svg>
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
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            >
              <path d="M3 5h13" />
              <path d="M6 12h11" />
              <path d="M9 19h8" />
            </svg>
            View trace
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function FollowFieldButton({
  field,
  value,
  role,
  disabled,
  disabledTitle,
  onFollow,
  onOpenFields,
}: {
  field: string;
  value: string;
  role: FieldRole | undefined;
  disabled?: boolean;
  disabledTitle?: string;
  onFollow: () => void;
  onOpenFields?: () => void;
}) {
  const token = formatFieldToken(field, value);
  const scanRole = followScanRole(role);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-[22px]"
          title={disabled ? disabledTitle : `Follow ${token} — every service, ±5m`}
          aria-label="Follow this value"
          disabled={disabled}
        >
          <FollowIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] bg-[#18181b] p-2">
        <div className="px-1.5 pb-1.5">
          <div className="text-[12.5px] font-medium">Follow this value</div>
          <div className="mt-0.5 font-mono text-[12px] break-all">{token}</div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            ±5m around this event · every service
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            Opens a new tab · this one stays as it is.
          </div>
          {scanRole === "lookup" ? (
            <div className="mt-1 text-[11.5px] text-muted-foreground">
              Indexed — this key is set to lookup.
            </div>
          ) : (
            <div className="mt-1 text-[11.5px] text-amber-200/90">
              {field} is set to {scanRole}, so this is a scan.{" "}
              {onOpenFields ? (
                <PopoverClose asChild>
                  <button
                    type="button"
                    className="underline"
                    onClick={onOpenFields}
                  >
                    Set in Fields
                  </button>
                </PopoverClose>
              ) : null}
            </div>
          )}
        </div>
        <PopoverClose asChild>
          <Button
            type="button"
            size="sm"
            className="h-7 w-full text-[12.5px]"
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            onClick={onFollow}
          >
            Follow
          </Button>
        </PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

function GraphIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 19h16" />
      <path d="M5 15l4.2-5 3.3 3.2L19 6" />
    </svg>
  );
}
