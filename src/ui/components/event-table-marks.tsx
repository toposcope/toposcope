import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  formatChangeMarkLabel,
  type ChangeMark,
} from "../../shared/change-mark";
import {
  clusterKinds,
  foldMarkLabel,
  incidentEndLabel,
  markSource,
} from "../change-marks";
import { formatSpanShort } from "../time-range";
import { isTypingTarget } from "@/keyboard";
import { cn } from "@/lib/utils";
import { MarkGlyph, markKindColor } from "./histogram-marks";

function stamp(iso: string): string {
  return iso.slice(0, 23).replace("T", " ");
}

function ago(iso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  return `${formatSpanShort(ms)} ago`;
}

function InspectRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-[52px] shrink-0 font-mono text-[10.5px] text-muted-foreground/75">
        {k}
      </span>
      <span className="font-mono text-[11px] text-foreground/88 whitespace-nowrap">
        {v}
      </span>
    </div>
  );
}

function MarkInspectCard({
  mark,
  nowMs,
  onHide,
}: {
  mark: ChangeMark;
  nowMs: number;
  onHide: () => void;
}) {
  return (
    <div className="absolute top-[22px] left-11 z-20 w-[254px] rounded-md border bg-popover p-2.5 shadow-lg">
      <div className="flex items-center gap-1.5">
        <MarkGlyph kind={mark.kind} size={12} />
        <span className="text-[12.5px] font-semibold whitespace-nowrap">
          {formatChangeMarkLabel(mark)}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-0.5">
        <InspectRow k="time" v={stamp(mark.ts)} />
        <InspectRow k="" v={`${ago(mark.ts, nowMs)} · in window`} />
        {mark.service ? <InspectRow k="service" v={mark.service} /> : null}
        {markSource(mark) ? <InspectRow k="source" v={markSource(mark)!} /> : null}
        <InspectRow k="id" v={mark.id} />
      </div>
      <div className="mt-2.5 flex items-center border-t pt-2">
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11.5px]"
          onClick={onHide}
        >
          Hide for this hunt
        </button>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
        Hiding is per-hunt visibility. The store is not edited from this panel.
      </p>
    </div>
  );
}

function ruleClass(opts: {
  selected: boolean;
  hovered: boolean;
  end: boolean;
  kind: ChangeMark["kind"];
}): { background: string } {
  if (opts.end) {
    return {
      background:
        "repeating-linear-gradient(90deg, rgba(239,68,68,0.5) 0 4px, transparent 4px 7px)",
    };
  }
  const color = markKindColor(opts.kind);
  if (opts.selected) {
    return { background: color };
  }
  if (opts.hovered) {
    return {
      background: `repeating-linear-gradient(90deg, color-mix(in oklab, ${color} 60%, transparent) 0 4px, transparent 4px 7px)`,
    };
  }
  return {
    background:
      "repeating-linear-gradient(90deg, oklch(1 0 0 / 0.22) 0 4px, transparent 4px 7px)",
  };
}

function SeamShell({
  selected,
  hovered,
  ring,
  end,
  kind,
  markId,
  onClick,
  onKeyDown,
  onHover,
  children,
}: {
  selected: boolean;
  hovered: boolean;
  ring: boolean;
  end: boolean;
  kind: ChangeMark["kind"];
  markId: string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onHover: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-mark-id={markId}
      className="relative flex h-[22px] w-full items-center border-b border-white/[0.06] px-2 text-left"
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <span
        className="pointer-events-none absolute top-1/2 right-2 left-2 h-px"
        style={ruleClass({ selected, hovered, end, kind })}
      />
      <span
        className={cn(
          "relative ml-3.5 inline-flex h-[18px] items-center gap-1.5 rounded-[3.4px] px-1.5",
          selected || hovered ? "bg-accent" : "bg-card",
          selected
            ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]"
            : "",
          ring ? "shadow-[0_0_0_1px_rgba(34,197,94,0.55)]" : "",
        )}
      >
        {children}
      </span>
    </button>
  );
}

export function EventSeam({
  mark,
  selected,
  ring,
  stampText,
  onSelect,
  onArrow,
}: {
  mark: ChangeMark;
  selected: boolean;
  ring: boolean;
  stampText: string;
  onSelect: () => void;
  onArrow: (dir: 1 | -1) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <SeamShell
      selected={selected}
      hovered={hovered}
      ring={ring}
      end={false}
      kind={mark.kind}
      markId={mark.id}
      onClick={onSelect}
      onHover={setHovered}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onArrow(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      <MarkGlyph kind={mark.kind} />
      <span className="text-[11px] text-foreground/80 whitespace-nowrap">
        {formatChangeMarkLabel(mark)}
      </span>
      <span className="font-mono text-[10.5px] text-muted-foreground whitespace-nowrap">
        {stampText}
      </span>
    </SeamShell>
  );
}

export function EventIncidentEnd({
  mark,
  selected,
  stampText,
  onSelect,
  onArrow,
}: {
  mark: ChangeMark;
  selected: boolean;
  stampText: string;
  onSelect: () => void;
  onArrow: (dir: 1 | -1) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <SeamShell
      selected={selected}
      hovered={hovered}
      ring={false}
      end
      kind="incident"
      markId={mark.id}
      onClick={onSelect}
      onHover={setHovered}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          onArrow(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      <span className="opacity-80">
        <MarkGlyph kind="incident" />
      </span>
      <span className="text-[11px] whitespace-nowrap text-red-300/85">
        {incidentEndLabel(mark)}
      </span>
      <span className="font-mono text-[10.5px] text-muted-foreground whitespace-nowrap">
        {stampText}
      </span>
    </SeamShell>
  );
}

export function EventFold({
  members,
  selected,
  open,
  rowHover,
  onToggle,
  onInspect,
  onMute,
  onHoverRow,
  onArrow,
}: {
  members: ChangeMark[];
  selected: boolean;
  open: boolean;
  rowHover: string | null;
  onToggle: () => void;
  onInspect: (mark: ChangeMark) => void;
  onMute: (id: string) => void;
  onHoverRow: (id: string | null) => void;
  onArrow: (dir: 1 | -1) => void;
}) {
  const kinds = clusterKinds({
    members,
    fromMs: Date.parse(members[0]?.ts ?? ""),
    toMs: Date.parse(members[members.length - 1]?.ts ?? ""),
  });
  const mixed = kinds.length > 1;
  const head = members[0]!;
  return (
    <div className="relative">
      <SeamShell
        selected={selected}
        hovered={false}
        ring={false}
        end={false}
        kind={head.kind}
        markId={members.map((item) => item.id).join(" ")}
        onClick={onToggle}
        onHover={() => {}}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            onArrow(e.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        <span className="inline-flex h-[18px] items-center gap-1.5 rounded-[3.4px] border border-white/18 px-1.5">
          {mixed ? null : <MarkGlyph kind={head.kind} />}
          {mixed
            ? kinds.slice(0, 3).map((kind) => (
                <span
                  key={kind}
                  className="size-[5px] rounded-full"
                  style={{ background: markKindColor(kind) }}
                />
              ))
            : null}
          <span className="text-[11px] text-foreground/80 whitespace-nowrap">
            {foldMarkLabel(members)}
          </span>
        </span>
      </SeamShell>
      {open ? (
        <div className="absolute top-[22px] left-[340px] z-20 w-[278px] max-w-[calc(100%-24px)] rounded-md border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[12px] font-semibold">
            {foldMarkLabel(members)}
            <button
              type="button"
              className="ml-auto flex size-[18px] items-center justify-center rounded-sm text-muted-foreground"
              onClick={onToggle}
            >
              ×
            </button>
          </div>
          <div className="flex flex-col p-1">
            {members.map((row) => (
              <button
                key={row.id}
                type="button"
                className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left"
                onMouseEnter={() => onHoverRow(row.id)}
                onMouseLeave={() => onHoverRow(null)}
                onClick={() => onInspect(row)}
              >
                <MarkGlyph kind={row.kind} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
                  {formatChangeMarkLabel(row)}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {row.ts.slice(11, 19)}
                </span>
                {rowHover === row.id ? (
                  <span
                    className="rounded-sm border px-1.5 py-px text-[10px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMute(row.id);
                    }}
                  >
                    hide
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="border-t px-2.5 py-1.5 text-[10.5px] text-muted-foreground/80">
            A row inspects its mark · hide mutes it for this hunt only.
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EventMarksPeek({
  below,
  onLoadToward,
}: {
  below: ChangeMark[];
  onLoadToward: (ts: string) => void;
}) {
  const nearest = below[0];
  if (!nearest) {
    return null;
  }
  const count = below.length;
  return (
    <button
      type="button"
      className="sticky bottom-0 z-[5] flex h-[22px] w-full items-center gap-1.5 border-t bg-card px-2 text-left font-mono text-[11px] text-muted-foreground"
      onClick={() => onLoadToward(nearest.ts)}
    >
      <MarkGlyph kind={nearest.kind} />
      <span className="min-w-0 truncate">
        {count} {count === 1 ? "mark" : "marks"} below the loaded rows — nearest{" "}
        {formatChangeMarkLabel(nearest)} · {nearest.ts.slice(11, 19)}
      </span>
      <span className="ml-auto text-muted-foreground/70">▾</span>
    </button>
  );
}

export function EventMarkInspect({
  mark,
  nowMs,
  onHide,
}: {
  mark: ChangeMark;
  nowMs: number;
  onHide: () => void;
}) {
  return <MarkInspectCard mark={mark} nowMs={nowMs} onHide={onHide} />;
}

export function useMarkDismiss(open: boolean, onClose: () => void): {
  rootRef: RefObject<HTMLDivElement | null>;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || isTypingTarget(e.target)) {
        return;
      }
      e.preventDefault();
      onClose();
    }
    function onDown(e: MouseEvent) {
      if (!rootRef.current) {
        return;
      }
      if (e.target instanceof Node && rootRef.current.contains(e.target)) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);
  return { rootRef };
}
