import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BOARD_PANEL_MAX } from "../boards";

/** A board a hunt panel can be added to (39e), and how many panels it has. */
export type BoardChoice = { id: string; name: string; count: number };

const row =
  "flex h-[26px] w-full items-center gap-2.5 rounded-sm px-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45";

/** The boards, with their panel counts, then New board… (39e). A full board takes no more. */
export function AddToBoardList({
  boards,
  onPick,
  close,
}: {
  boards: BoardChoice[];
  onPick: (boardId: string | null) => void;
  close: () => void;
}) {
  return (
    <>
      {boards.map((board) => {
        const full = board.count >= BOARD_PANEL_MAX;
        return (
          <button
            key={board.id}
            type="button"
            className={row}
            disabled={full}
            title={full ? `${BOARD_PANEL_MAX} panels is the most a board holds` : undefined}
            onClick={() => {
              close();
              onPick(board.id);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{board.name}</span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">{board.count}</span>
          </button>
        );
      })}
      {boards.length > 0 ? <div className="my-1 h-px bg-white/[0.08]" /> : null}
      <button
        type="button"
        className={row}
        onClick={() => {
          close();
          // The menu closes first, so New board's dialog takes the focus.
          setTimeout(() => onPick(null), 0);
        }}
      >
        New board…
      </button>
    </>
  );
}

/** Add to board in the pinned plot's head (39e). */
export function AddToBoardButton({
  boards,
  onPick,
  className,
}: {
  boards: BoardChoice[];
  onPick: (boardId: string | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-[26px] shrink-0 rounded-md border border-input px-[9px] text-sm whitespace-nowrap hover:bg-accent",
            className,
          )}
        >
          Add to board
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] bg-overlay p-1">
        <AddToBoardList boards={boards} onPick={onPick} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
