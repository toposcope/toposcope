import type { BoardSlots } from "../shared/boards";

/** A board's row in the command palette: how many panels, then its inputs (`4 panels · host`). */
export function boardPaletteDetail(board: BoardSlots): string {
  const n = board.panels.length;
  return [`${n} ${n === 1 ? "panel" : "panels"}`, ...board.keys].join(" · ");
}
