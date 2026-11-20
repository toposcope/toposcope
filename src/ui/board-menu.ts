/** A board's name, typed in place in its head (49d). */
export const maxBoardName = 120;

export type BoardMenuItem = { id: "rename" | "duplicate" | "pin" | "delete"; label: string };

/** The board's ⋯ menu (49g): Pin or Unpin as the board is now, Delete last, past a line. */
export function boardMenuItems(pinned: boolean): BoardMenuItem[] {
  return [
    { id: "rename", label: "Rename" },
    { id: "duplicate", label: "Duplicate board" },
    { id: "pin", label: pinned ? "Unpin from Home" : "Pin to Home" },
    { id: "delete", label: "Delete board…" },
  ];
}
