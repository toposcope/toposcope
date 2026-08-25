import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  changeMarkKinds,
  formatChangeMarkLabel,
  type ChangeMark,
  type ChangeMarkKind,
} from "../../shared/change-mark";
import { formatSpanShort } from "../time-range";
import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/keyboard";
import {
  clusterChangeMarks,
  clusterHasLaneLabel,
  clusterKinds,
  markFrac,
  markSource,
  newestFirst,
  panWindowToMark,
  peekCrowded,
  visibleChangeMarks,
} from "../change-marks";

export const MARK_LANE_H = 22;

const VISUAL: Record<
  ChangeMarkKind,
  { d: string; f: string; s: string; w: string; color: string }
> = {
  deploy: {
    d: "M6 1.6 L11 10.4 L1 10.4 Z",
    f: "oklch(0.906 0.014 84)",
    s: "none",
    w: "0",
    color: "oklch(0.906 0.014 84)",
  },
  flag: {
    d: "M2.4 1.2 L2.4 11 M2.4 2 L9.7 2 L7.7 4.7 L9.7 7.4 L2.4 7.4 Z",
    f: "#2dd4bf",
    s: "#2dd4bf",
    w: "1.2",
    color: "#2dd4bf",
  },
  incident: {
    d: "M6 0.9 L11.1 6 L6 11.1 L0.9 6 Z",
    f: "#ef4444",
    s: "none",
    w: "0",
    color: "#ef4444",
  },
  note: {
    d: "M6 2 A4 4 0 1 1 5.99 2",
    f: "none",
    s: "oklch(0.705 0.015 286.067)",
    w: "1.5",
    color: "oklch(0.705 0.015 286.067)",
  },
};

function visual(kind: ChangeMarkKind): (typeof VISUAL)[ChangeMarkKind] {
  return VISUAL[kind] ?? VISUAL.note;
}

export function MarkGlyph({
  kind,
  size = 11,
}: {
  kind: ChangeMarkKind;
  size?: number;
}) {
  const v = visual(kind);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className="block shrink-0"
      aria-hidden
    >
      <path
        d={v.d}
        fill={v.f}
        stroke={v.s}
        strokeWidth={v.w}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function marksClusterKey(cluster: {
  fromMs: number;
  toMs: number;
}): string {
  return `${cluster.fromMs}:${cluster.toMs}`;
}

function Rule({
  frac,
  state,
  kind,
}: {
  frac: number;
  state: "rest" | "hover" | "sel";
  kind: ChangeMarkKind;
}) {
  const color =
    state === "sel"
      ? visual(kind).color
      : state === "hover"
        ? `color-mix(in oklab, ${visual(kind).color} 60%, transparent)`
        : "oklch(1 0 0 / 0.22)";
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-[2] w-px"
      style={{
        left: `${(frac * 100).toFixed(3)}%`,
        background:
          state === "sel"
            ? color
            : `repeating-linear-gradient(180deg, ${color} 0 4px, transparent 4px 7px)`,
        opacity: state === "sel" ? 0.85 : 1,
      }}
    />
  );
}

export type MarksOverlay = {
  marks: ChangeMark[];
  before: ChangeMark | null;
  after: ChangeMark | null;
  offKinds: ChangeMarkKind[];
  mutedIds: string[];
  onToggleKind: (kind: ChangeMarkKind) => void;
  onMute: (id: string) => void;
  onUnmute: (id: string) => void;
};

type Open =
  | { kind: "inspect"; id: string }
  | { kind: "cluster"; key: string }
  | null;

function stamp(iso: string): string {
  return iso.slice(0, 23).replace("T", " ");
}

function ago(iso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  return `${formatSpanShort(ms)} ago`;
}

export function HistogramMarkRules({
  overlay,
  fromMs,
  spanMs,
  hoverKey,
  selectedKey,
  selectedId,
}: {
  overlay: MarksOverlay;
  fromMs: number;
  spanMs: number;
  hoverKey: string | null;
  selectedKey: string | null;
  selectedId: string | null;
}) {
  const visible = visibleChangeMarks(
    overlay.marks,
    overlay.offKinds,
    overlay.mutedIds,
  );
  const clusters = clusterChangeMarks(visible, spanMs);
  return (
    <>
      {visible
        .filter((mark) => mark.kind === "incident" && mark.end_ts)
        .map((mark) => {
          const a = Date.parse(mark.ts);
          const b = Date.parse(mark.end_ts!);
          const left = markFrac(a, fromMs, spanMs);
          const right = markFrac(b, fromMs, spanMs);
          const l = Math.max(0, Math.min(1, left));
          const r = Math.max(0, Math.min(1, right));
          if (r <= l) {
            return null;
          }
          return (
            <div key={`band-${mark.id}`}>
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-[1]"
                style={{
                  left: `${(l * 100).toFixed(3)}%`,
                  width: `${((r - l) * 100).toFixed(3)}%`,
                  background: "rgba(239,68,68,0.07)",
                }}
              />
              <Rule frac={l} state="hover" kind="incident" />
              <Rule frac={r} state="hover" kind="incident" />
            </div>
          );
        })}
      {clusters.map((cluster) => {
        const key = marksClusterKey(cluster);
        const kind = cluster.members[0]?.kind ?? "note";
        const state: "rest" | "hover" | "sel" =
          selectedId && cluster.members.some((m) => m.id === selectedId)
            ? "sel"
            : selectedKey === key || hoverKey === key
              ? "hover"
              : "rest";
        const left = markFrac(cluster.fromMs, fromMs, spanMs);
        const right = markFrac(cluster.toMs, fromMs, spanMs);
        return (
          <div key={key}>
            {cluster.members.length > 1 ? (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-[1]"
                style={{
                  left: `${(Math.min(left, right) * 100).toFixed(3)}%`,
                  width: `${(Math.max(0.003, Math.abs(right - left)) * 100).toFixed(3)}%`,
                  background: "oklch(1 0 0 / 9%)",
                }}
              />
            ) : null}
            <Rule frac={(left + right) / 2} state={state} kind={kind} />
          </div>
        );
      })}
    </>
  );
}

export function HistogramMarkLane({
  overlay,
  fromMs,
  spanMs,
  live,
  nowMs,
  slidePct,
  onWindow,
  onLaneHover,
  hoverKey,
  onHoverKey,
  onSelect,
}: {
  overlay: MarksOverlay;
  fromMs: number;
  spanMs: number;
  live: boolean;
  nowMs: number;
  slidePct: number | null;
  onWindow: (fromIso: string, toIso: string) => void;
  onLaneHover: (on: boolean) => void;
  hoverKey: string | null;
  onHoverKey: (key: string | null) => void;
  onSelect: (next: { id: string | null; key: string | null }) => void;
}): ReactNode {
  const [open, setOpen] = useState<Open>(null);
  const [rowHover, setRowHover] = useState<string | null>(null);
  const [rings, setRings] = useState<Set<string>>(() => new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const toMs = fromMs + spanMs;

  const visible = visibleChangeMarks(
    overlay.marks,
    overlay.offKinds,
    overlay.mutedIds,
  );
  const clusters = clusterChangeMarks(visible, spanMs);

  useEffect(() => {
    const next = new Set<string>();
    for (const mark of overlay.marks) {
      if (live && !seenRef.current.has(mark.id) && seenRef.current.size > 0) {
        next.add(mark.id);
      }
    }
    seenRef.current = new Set(overlay.marks.map((mark) => mark.id));
    if (next.size === 0) {
      return;
    }
    setRings(next);
    const timer = window.setTimeout(() => setRings(new Set()), 1800);
    return () => window.clearTimeout(timer);
  }, [overlay.marks, live]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isTypingTarget(e.target) || !open) {
        return;
      }
      e.preventDefault();
      setOpen(null);
    }
    function onDown(e: MouseEvent) {
      if (!open || !rootRef.current) {
        return;
      }
      if (e.target instanceof Node && rootRef.current.contains(e.target)) {
        return;
      }
      setOpen(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const selectedId = open?.kind === "inspect" ? open.id : null;
  const selectedCluster = open?.kind === "cluster" ? open.key : null;
  useEffect(() => {
    onSelectRef.current({ id: selectedId, key: selectedCluster });
  }, [selectedId, selectedCluster]);

  const leftPeek = overlay.before;
  const rightPeek = live ? null : overlay.after;
  const leftCrowd = peekCrowded("left", clusters, fromMs, spanMs);
  const rightCrowd = peekCrowded("right", clusters, fromMs, spanMs);

  function peek(mark: ChangeMark) {
    const next = panWindowToMark(fromMs, toMs, Date.parse(mark.ts));
    setOpen(null);
    onWindow(new Date(next.fromMs).toISOString(), new Date(next.toMs).toISOString());
  }

  function inspect(mark: ChangeMark) {
    setOpen((prev) =>
      prev?.kind === "inspect" && prev.id === mark.id
        ? null
        : { kind: "inspect", id: mark.id },
    );
  }

  const inspectMark = selectedId
    ? (visible.find((mark) => mark.id === selectedId) ?? null)
    : null;

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      style={{ height: MARK_LANE_H }}
    >
      <div
        className="relative h-[22px]"
        onPointerEnter={() => onLaneHover(true)}
        onPointerLeave={() => {
          onLaneHover(false);
          onHoverKey(null);
        }}
      >
        <div
          className="absolute inset-0"
          style={
            slidePct != null
              ? { transform: `translateX(${slidePct.toFixed(3)}%)` }
              : undefined
          }
        >
          {clusters.map((cluster) => {
            const key = marksClusterKey(cluster);
            const mid = (cluster.fromMs + cluster.toMs) / 2;
            const frac = markFrac(mid, fromMs, spanMs);
            if (frac < 0 || frac > 1) {
              return null;
            }
            const kinds = clusterKinds(cluster);
            const mixed = kinds.length > 1;
            const head = newestFirst(cluster.members)[0]!;
            const label = clusterHasLaneLabel(cluster, clusters, spanMs)
              ? formatChangeMarkLabel(head)
              : null;
            const selected =
              selectedCluster === key ||
              (selectedId != null &&
                cluster.members.some((m) => m.id === selectedId));
            const hovered = hoverKey === key;
            return (
              <button
                key={key}
                type="button"
                className={cn(
                  "absolute top-1/2 z-[3] flex h-[18px] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-sm whitespace-nowrap px-1 text-[11px] text-foreground/80",
                  cluster.members.length > 1 || hovered || selected
                    ? "border border-white/18 bg-accent/70"
                    : "",
                  selected
                    ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]"
                    : "",
                  rings.has(head.id)
                    ? "shadow-[0_0_0_1px_rgba(34,197,94,0.55)]"
                    : "",
                )}
                style={{ left: `${(frac * 100).toFixed(3)}%` }}
                onPointerEnter={() => onHoverKey(key)}
                onPointerLeave={() => onHoverKey(null)}
                onClick={() => {
                  if (cluster.members.length > 1) {
                    setOpen((prev) =>
                      prev?.kind === "cluster" && prev.key === key
                        ? null
                        : { kind: "cluster", key },
                    );
                    return;
                  }
                  inspect(head);
                }}
              >
                {cluster.members.length === 1 ? (
                  <>
                    <MarkGlyph kind={head.kind} />
                    {label ? <span>{label}</span> : null}
                  </>
                ) : mixed ? (
                  <>
                    <span className="font-mono text-[10.5px]">
                      {cluster.members.length}
                    </span>
                    {kinds.map((kind) => (
                      <span
                        key={kind}
                        className="size-[5px] rounded-full"
                        style={{ background: visual(kind).color }}
                      />
                    ))}
                  </>
                ) : (
                  <>
                    <MarkGlyph kind={head.kind} />
                    <span className="font-mono text-[10.5px]">
                      {cluster.members.length}
                    </span>
                  </>
                )}
              </button>
            );
          })}

          {open?.kind === "cluster"
            ? clusters
                .filter((cluster) => marksClusterKey(cluster) === open.key)
                .map((cluster) => {
                  const frac = markFrac(
                    (cluster.fromMs + cluster.toMs) / 2,
                    fromMs,
                    spanMs,
                  );
                  const rows = newestFirst(cluster.members);
                  return (
                    <div
                      key="cluster-pop"
                      className="absolute z-[9] w-[266px] rounded-md border bg-popover shadow-lg"
                      style={{
                        bottom: 22,
                        left: `${(frac * 100).toFixed(3)}%`,
                        transform:
                          frac > 0.6 ? "translateX(-100%)" : "translateX(8px)",
                      }}
                    >
                      <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[12px] font-semibold">
                        {rows.length} marks
                        <button
                          type="button"
                          className="ml-auto flex size-[18px] items-center justify-center rounded-sm text-muted-foreground"
                          onClick={() => setOpen(null)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="flex flex-col p-1">
                        {rows.map((row) => (
                          <button
                            key={row.id}
                            type="button"
                            className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left"
                            onMouseEnter={() => setRowHover(row.id)}
                            onMouseLeave={() => setRowHover(null)}
                            onClick={() => inspect(row)}
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
                                  overlay.onMute(row.id);
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
                  );
                })
            : null}

          {inspectMark ? (
            <div
              className="absolute z-[9] w-[254px] rounded-md border bg-popover p-2.5 shadow-lg"
              style={{
                bottom: 22,
                left: `${(markFrac(Date.parse(inspectMark.ts), fromMs, spanMs) * 100).toFixed(3)}%`,
                transform:
                  markFrac(Date.parse(inspectMark.ts), fromMs, spanMs) > 0.6
                    ? "translateX(-100%)"
                    : "translateX(8px)",
              }}
            >
              <div className="flex items-center gap-1.5">
                <MarkGlyph kind={inspectMark.kind} size={12} />
                <span className="text-[12.5px] font-semibold whitespace-nowrap">
                  {formatChangeMarkLabel(inspectMark)}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-0.5">
                <InspectRow k="time" v={stamp(inspectMark.ts)} />
                <InspectRow
                  k=""
                  v={`${ago(inspectMark.ts, nowMs)} · in window`}
                />
                {inspectMark.service ? (
                  <InspectRow k="service" v={inspectMark.service} />
                ) : null}
                {markSource(inspectMark) ? (
                  <InspectRow k="source" v={markSource(inspectMark)!} />
                ) : null}
                <InspectRow k="id" v={inspectMark.id} />
              </div>
              <div className="mt-2.5 flex items-center border-t pt-2">
                <button
                  type="button"
                  className="flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11.5px]"
                  onClick={() => {
                    overlay.onMute(inspectMark.id);
                    setOpen(null);
                  }}
                >
                  Hide for this hunt
                </button>
              </div>
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
                Hiding is per-hunt visibility. The store is not edited from this panel.
              </p>
            </div>
          ) : null}
        </div>

        {leftPeek ? (
          <button
            type="button"
            className="absolute top-1/2 left-0.5 z-[6] flex h-[18px] -translate-y-1/2 items-center gap-1 rounded-sm border border-dashed border-white/25 bg-card px-1.5 font-mono text-[10.5px] text-muted-foreground"
            onClick={() => peek(leftPeek)}
          >
            <span className="text-muted-foreground/70">◂</span>
            <MarkGlyph kind={leftPeek.kind} size={10} />
            {leftCrowd ? null : (
              <span>
                {leftPeek.kind} · {formatSpanShort(fromMs - Date.parse(leftPeek.ts))}{" "}
                before
              </span>
            )}
          </button>
        ) : null}
        {rightPeek ? (
          <button
            type="button"
            className="absolute top-1/2 right-0.5 z-[6] flex h-[18px] -translate-y-1/2 items-center gap-1 rounded-sm border border-dashed border-white/25 bg-card px-1.5 font-mono text-[10.5px] text-muted-foreground"
            onClick={() => peek(rightPeek)}
          >
            {rightCrowd ? null : (
              <span>
                {rightPeek.kind} · {formatSpanShort(Date.parse(rightPeek.ts) - toMs)}{" "}
                after
              </span>
            )}
            <MarkGlyph kind={rightPeek.kind} size={10} />
            <span className="text-muted-foreground/70">▸</span>
          </button>
        ) : null}
      </div>
    </div>
  );
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

export function HistogramMarksChip({ overlay }: { overlay: MarksOverlay }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const visible = visibleChangeMarks(
    overlay.marks,
    overlay.offKinds,
    overlay.mutedIds,
  );
  const hidden = visible.length < overlay.marks.length;
  const chipCount = hidden
    ? `${visible.length} of ${overlay.marks.length}`
    : String(overlay.marks.length);
  const counts = Object.fromEntries(
    changeMarkKinds.map((kind) => [
      kind,
      overlay.marks.filter((mark) => mark.kind === kind).length,
    ]),
  ) as Record<ChangeMarkKind, number>;
  const muted = overlay.marks.filter((mark) =>
    overlay.mutedIds.includes(mark.id),
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isTypingTarget(e.target) || !open) {
        return;
      }
      e.preventDefault();
      setOpen(false);
    }
    function onDown(e: MouseEvent) {
      if (!open || !rootRef.current) {
        return;
      }
      if (e.target instanceof Node && rootRef.current.contains(e.target)) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative ml-auto">
      <button
        type="button"
        className={cn(
          "flex h-5 items-center gap-1 rounded-sm border px-1.5 font-mono text-[10.5px]",
          hidden ? "border-amber-400/40 text-amber-400" : "text-muted-foreground",
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          aria-hidden
        >
          <path d="M2.5 2.2 H8 L10.3 4.6 L8 7 H2.5 Z" />
          <path d="M5.2 7 V10.4" />
        </svg>
        marks {chipCount}
      </button>
      {open ? (
        <div className="absolute right-0 bottom-full z-20 mb-1 w-[240px] rounded-md border bg-popover p-1 shadow-lg">
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Marks
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70">
              this hunt
            </span>
          </div>
          {changeMarkKinds.map((kind) => {
            const on = !overlay.offKinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1",
                  on ? "" : "opacity-50",
                )}
                onClick={() => overlay.onToggleKind(kind)}
              >
                <span
                  className={cn(
                    "flex size-[13px] items-center justify-center rounded-[3px] border text-[9px] leading-none",
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-white/30",
                  )}
                >
                  {on ? "✓" : ""}
                </span>
                <MarkGlyph kind={kind} />
                <span className="flex-1 text-left text-[12px]">{kind}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {counts[kind]}
                </span>
              </button>
            );
          })}
          {muted.length > 0 ? (
            <>
              <div className="px-1.5 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Hidden
              </div>
              {muted.map((mark) => (
                <div
                  key={mark.id}
                  className="flex items-center gap-1.5 rounded-sm px-1.5 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                    {formatChangeMarkLabel(mark)}
                  </span>
                  <button
                    type="button"
                    className="flex size-4 items-center justify-center rounded-sm text-muted-foreground"
                    onClick={() => overlay.onUnmute(mark.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          ) : null}
          <p className="mt-1 border-t px-1.5 py-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
            Kind toggles and per-mark mutes are visibility for this hunt. They do not
            delete the mark.
          </p>
        </div>
      ) : null}
    </span>
  );
}

export function markHoverLines(
  overlay: MarksOverlay | null | undefined,
  bucketMs: number,
  stepMs: number,
): { label: string; kind: ChangeMarkKind; t: string }[] {
  if (!overlay) {
    return [];
  }
  const visible = visibleChangeMarks(
    overlay.marks,
    overlay.offKinds,
    overlay.mutedIds,
  );
  const end = bucketMs + stepMs;
  return newestFirst(
    visible.filter((mark) => {
      const t = Date.parse(mark.ts);
      return t >= bucketMs && t < end;
    }),
  ).map((mark) => ({
    label: formatChangeMarkLabel(mark),
    kind: mark.kind,
    t: mark.ts.slice(11, 19),
  }));
}
