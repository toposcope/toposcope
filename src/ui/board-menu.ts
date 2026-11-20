/** A board's name, typed in place in its head (49d). */
export const maxBoardName = 120;

export type BoardMenuItem = { id: "rename" | "fit" | "duplicate" | "pin" | "delete"; label: string; sub?: string };

/**
 * The board's ⋯ menu (49g, 50e): Rename, Fit panels to the width, Duplicate, Pin or Unpin as the
 * board is now, Delete last, past a line. Viewers get no menu.
 */
export function boardMenuItems(pinned: boolean): BoardMenuItem[] {
  return [
    { id: "rename", label: "Rename" },
    { id: "fit", label: "Fit panels to the width", sub: "Each row's panels share the 12 columns" },
    { id: "duplicate", label: "Duplicate board" },
    { id: "pin", label: pinned ? "Unpin from Home" : "Pin to Home" },
    { id: "delete", label: "Delete board…" },
  ];
}
