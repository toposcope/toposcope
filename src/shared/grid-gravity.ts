/**
 * Panel layout on the 12-col grid (sheet 44, picked E · Gravity): a panel lands in the columns
 * it is dropped on, the panels in its way go down, then every panel floats up so no hole is left.
 * Hunts and boards share it. Anchored cells (the hunt's pinned plot) never move.
 */

export type GridCell = { id: string; x: number; y: number; w: number; h: number };
/** The handles a panel has: the right and bottom edges push, the left and top edges trade. */
export type GridEdge = "n" | "s" | "e" | "w" | "se";

export const gridCols = 12;

export function cellsOverlap(a: GridCell, b: GridCell): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const byPosition = (a: GridCell, b: GridCell) => a.y - b.y || a.x - b.x;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The fixed cells keep their place; every other cell goes down past what is already placed,
 * then each cell but the anchored ones floats up as far as it can. Returns cells in input order.
 */
export function gravity<T extends GridCell>(cells: T[], fixed: T[] = [], anchored: ReadonlySet<string> = new Set()): T[] {
  const placed: T[] = fixed.map((cell) => ({ ...cell }));
  const fixedIds = new Set(fixed.map((cell) => cell.id));
  const rest = cells.filter((cell) => !fixedIds.has(cell.id)).map((cell) => ({ ...cell })).sort(byPosition);
  for (const cell of rest) {
    while (placed.some((other) => cellsOverlap(cell, other))) {
      cell.y++;
    }
    placed.push(cell);
  }
  for (const cell of placed.slice().sort(byPosition)) {
    if (anchored.has(cell.id)) {
      continue;
    }
    while (cell.y > 0) {
      cell.y--;
      if (placed.some((other) => other !== cell && cellsOverlap(cell, other))) {
        cell.y++;
        break;
      }
    }
  }
  const byId = new Map(placed.map((cell) => [cell.id, cell]));
  return cells.map((cell) => byId.get(cell.id) ?? cell);
}

function anchorsOf<T extends GridCell>(cells: T[], anchored: ReadonlySet<string>, but: string): T[] {
  return cells.filter((cell) => anchored.has(cell.id) && cell.id !== but);
}

/** Drop `id` at (x, y): it keeps those columns, the panels in its way make room, everything floats up. */
export function gravityMove<T extends GridCell>(cells: T[], id: string, x: number, y: number, anchored: ReadonlySet<string> = new Set()): T[] {
  const me = cells.find((cell) => cell.id === id);
  if (!me || anchored.has(id)) {
    return cells;
  }
  const anchors = anchorsOf(cells, anchored, id);
  const cell = { ...me, x: clamp(Math.round(x), 0, gridCols - me.w), y: Math.max(0, Math.round(y)) };
  while (anchors.some((a) => cellsOverlap(cell, a))) {
    cell.y++;
  }
  return gravity(cells, [...anchors, cell], anchored);
}

export type ResizeLimits<T extends GridCell> = {
  min: (cell: T) => { w: number; h: number };
  maxH: number;
  anchored?: ReadonlySet<string>;
};

/**
 * Drag `edge` of `id` by (dx, dy) whole cells. Right and bottom grow the panel and push what is in
 * the way. Left and top move the border shared with the panels touching that side, one growing as
 * the other shrinks. With nothing touching, the left edge grows into the empty columns or shrinks,
 * and the top edge only shrinks (the panel floats up anyway). An anchored panel keeps its corner.
 */
export function gravityResize<T extends GridCell>(cells: T[], id: string, edge: GridEdge, dx: number, dy: number, limits: ResizeLimits<T>): T[] {
  const anchored = limits.anchored ?? new Set<string>();
  const me = cells.find((cell) => cell.id === id);
  if (!me) {
    return cells;
  }
  const min = limits.min(me);
  const items = cells.map((cell) => ({ ...cell }));
  const cell = { ...me };
  if (edge === "e" || edge === "se") {
    cell.w = clamp(me.w + dx, min.w, gridCols - me.x);
  }
  if (edge === "s" || edge === "se") {
    cell.h = clamp(me.h + dy, min.h, limits.maxH);
  }
  if (edge === "w" && !anchored.has(id)) {
    const touching = items.filter((o) => o.id !== id && o.x + o.w === me.x && o.y < me.y + me.h && me.y < o.y + o.h);
    const k = touching.length
      ? clamp(-dx, -(me.w - min.w), Math.min(...touching.map((o) => o.w - limits.min(o).w)))
      : clamp(-dx, -(me.w - min.w), me.x);
    for (const o of touching) {
      o.w -= k;
    }
    cell.x = me.x - k;
    cell.w = me.w + k;
  }
  if (edge === "n" && !anchored.has(id)) {
    const touching = items.filter((o) => o.id !== id && o.y + o.h === me.y && o.x < me.x + me.w && me.x < o.x + o.w);
    if (touching.length) {
      const up = Math.min(limits.maxH - me.h, ...touching.map((o) => o.h - limits.min(o).h));
      const down = Math.min(me.h - min.h, ...touching.map((o) => limits.maxH - o.h));
      const k = clamp(-dy, -down, up);
      for (const o of touching) {
        o.h -= k;
      }
      cell.y = me.y - k;
      cell.h = me.h + k;
    } else {
      const k = clamp(-dy, -(me.h - min.h), 0);
      cell.y = me.y - k;
      cell.h = me.h + k;
    }
  }
  const anchors = anchorsOf(items, anchored, id);
  return gravity(items, anchored.has(id) ? [cell, ...anchors] : [...anchors, cell], anchored);
}

/** The edges a panel offers: an anchored panel keeps its top-left corner. */
export function gridEdges(anchoredPanel: boolean): GridEdge[] {
  return anchoredPanel ? ["e", "s", "se"] : ["n", "w", "e", "s", "se"];
}
