import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { gravityMove, gravityResize, gridCols, type GridCell, type GridEdge, type ResizeLimits } from "../shared/grid-gravity";

/**
 * Move and resize on the 12-col grid (sheet 44, E · Gravity), for hunts and boards alike: drag a
 * panel's head to move it, an edge to resize it. The others make room while you drag, so what you
 * see is what you get on drop. Esc cancels.
 */
type Drag = {
  id: string;
  mode: "move" | "resize";
  edge: GridEdge;
  pointerId: number;
  sx: number;
  sy: number;
  /** Where in the panel the pointer took it, in px. */
  ox: number;
  oy: number;
  start: GridCell[];
  from: GridCell;
};

type Options<T extends GridCell> = {
  gridRef: RefObject<HTMLDivElement | null>;
  cells: T[];
  rowPx: number;
  gapPx: number;
  limits: ResizeLimits<T>;
  /** A canvas row to a layout row, where the canvas draws extra rows (the hunt's Compare fold). */
  layoutRow?: (row: number) => number;
  onCommit: (cells: T[]) => void;
  disabled?: boolean;
};

export function useGridGestures<T extends GridCell>(opts: Options<T>) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<T[] | null>(null);
  const [lift, setLift] = useState<{ dx: number; dy: number } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const dragRef = useRef<Drag | null>(null);
  const previewRef = useRef<T[] | null>(null);
  dragRef.current = drag;
  previewRef.current = preview;

  function metrics() {
    const grid = optsRef.current.gridRef.current;
    if (!grid) {
      return null;
    }
    const rect = grid.getBoundingClientRect();
    const { gapPx, rowPx } = optsRef.current;
    return { rect, colStep: (rect.width + gapPx) / gridCols, rowStep: rowPx + gapPx };
  }

  function begin(e: PointerEvent, id: string, mode: "move" | "resize", edge: GridEdge = "se") {
    const o = optsRef.current;
    if (o.disabled || e.button !== 0) {
      return;
    }
    if (mode === "move" && (e.target as HTMLElement).closest("button, select, input, textarea, a, [role='menuitem']")) {
      return;
    }
    const from = o.cells.find((cell) => cell.id === id);
    const m = metrics();
    if (!from || !m) {
      return;
    }
    if (mode === "move" && o.limits.anchored?.has(id)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const panelLeft = from.x * m.colStep;
    const panelTop = from.y * m.rowStep;
    setDrag({
      id,
      mode,
      edge,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - m.rect.left - panelLeft,
      oy: e.clientY - m.rect.top - panelTop,
      start: o.cells.map((cell) => ({ ...cell })),
      from: { ...from },
    });
    setPreview(o.cells);
    setLift({ dx: 0, dy: 0 });
  }

  function onMove(e: globalThis.PointerEvent) {
    const d = dragRef.current;
    const m = metrics();
    if (!d || !m) {
      return;
    }
    const o = optsRef.current;
    const start = d.start as T[];
    if (d.mode === "move") {
      setLift({ dx: e.clientX - d.sx, dy: e.clientY - d.sy });
      const x = Math.round((e.clientX - m.rect.left - d.ox) / m.colStep);
      const row = Math.max(0, Math.round((e.clientY - m.rect.top - d.oy) / m.rowStep));
      const y = o.layoutRow ? o.layoutRow(row) : row;
      setPreview(gravityMove(start, d.id, x, y, o.limits.anchored));
      return;
    }
    const dx = Math.round((e.clientX - d.sx) / m.colStep);
    const dy = Math.round((e.clientY - d.sy) / m.rowStep);
    setPreview(gravityResize(start, d.id, d.edge, dx, dy, o.limits));
  }

  function finish(commit: boolean) {
    const d = dragRef.current;
    const next = previewRef.current;
    dragRef.current = null;
    setDrag(null);
    setPreview(null);
    setLift(null);
    if (!commit || !d || !next) {
      return;
    }
    const changed = next.some((cell) => {
      const was = d.start.find((s) => s.id === cell.id);
      return !was || was.x !== cell.x || was.y !== cell.y || was.w !== cell.w || was.h !== cell.h;
    });
    if (changed) {
      optsRef.current.onCommit(next);
    }
  }

  useEffect(() => {
    if (!drag) {
      return;
    }
    const move = (e: globalThis.PointerEvent) => onMove(e);
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id, drag?.mode]);

  const cells = preview ?? opts.cells;
  const moving = drag?.mode === "move" ? drag.id : null;
  const sizing = drag?.mode === "resize" ? drag.id : null;
  return {
    /** Where every panel sits now: the live preview while dragging. */
    cells,
    /** The panel being moved, drawn at its old cell and lifted by `lift`; its new cell is `ghost`. */
    moving,
    movingFrom: drag?.mode === "move" ? drag.from : null,
    lift,
    ghost: moving ? (cells.find((cell) => cell.id === moving) ?? null) : null,
    sizing,
    sizingEdge: drag?.mode === "resize" ? drag.edge : null,
    beginMove: (e: PointerEvent, id: string) => begin(e, id, "move"),
    beginResize: (e: PointerEvent, id: string, edge: GridEdge) => begin(e, id, "resize", edge),
    dragging: drag !== null,
  };
}

/**
 * Slides panels to their new cells (sheet 44): each `[data-grid-cell]` child that moved animates
 * from where it was. The panel under the pointer is left alone.
 */
export function useGridSlide(gridRef: RefObject<HTMLDivElement | null>, layoutKey: string, skip: string | null) {
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, DOMRect>();
    for (const el of grid.querySelectorAll<HTMLElement>("[data-grid-cell]")) {
      const id = el.dataset.gridCell ?? "";
      const rect = el.getBoundingClientRect();
      next.set(id, rect);
      const was = last.current.get(id);
      if (!was || id === skip || reduce || typeof el.animate !== "function") {
        continue;
      }
      const dx = was.left - rect.left;
      const dy = was.top - rect.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 160, easing: "ease-out" });
      }
    }
    last.current = next;
  }, [gridRef, layoutKey, skip]);
}

const edgeLabel: Record<GridEdge, string> = {
  n: "Resize from the top",
  s: "Resize from the bottom",
  e: "Resize from the right",
  w: "Resize from the left",
  se: "Resize",
};

/** The edge handles of one panel (44f): bars on the edges, a square on the corner; shown on hover. */
export function GridHandles({
  edges,
  active,
  onPointerDown,
}: {
  edges: GridEdge[];
  active: GridEdge | null;
  onPointerDown: (e: PointerEvent, edge: GridEdge) => void;
}) {
  return (
    <>
      {edges.map((edge) => {
        const on = active === edge;
        const shown = on ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100";
        const bar = cn("absolute rounded-full", on ? "bg-plate" : "bg-plate/70");
        const place =
          edge === "e"
            ? "top-1/2 -right-[6px] h-9 w-3 -translate-y-1/2 cursor-ew-resize"
            : edge === "w"
              ? "top-1/2 -left-[6px] h-9 w-3 -translate-y-1/2 cursor-ew-resize"
              : edge === "n"
                ? "left-1/2 -top-[6px] h-3 w-9 -translate-x-1/2 cursor-ns-resize"
                : edge === "s"
                  ? "left-1/2 -bottom-[6px] h-3 w-9 -translate-x-1/2 cursor-ns-resize"
                  : "-right-[6px] -bottom-[6px] size-3.5 cursor-se-resize";
        return (
          <div
            key={edge}
            data-widget-handle="resize"
            data-edge={edge}
            aria-hidden="true"
            title={edgeLabel[edge]}
            className={cn("absolute z-20 touch-none transition-opacity", place, shown)}
            onPointerDown={(e) => onPointerDown(e, edge)}
          >
            {edge === "se" ? (
              <span className="absolute inset-[2px] rounded-[2px] border-[1.5px] border-plate/80 bg-card" />
            ) : edge === "e" || edge === "w" ? (
              <span className={cn(bar, "inset-y-0.5 left-1 w-1")} />
            ) : (
              <span className={cn(bar, "inset-x-0.5 top-1 h-1")} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** `8 × 6` beside a panel while it is being resized (44g). */
export function GridSizeChip({ w, h }: { w: number; h: number }) {
  return (
    <span className="pointer-events-none absolute right-2 bottom-2 z-30 rounded-[4px] border border-white/14 bg-popover px-1.5 font-mono text-[11px] leading-[20px] tabular-nums">
      {w} × {h}
    </span>
  );
}
