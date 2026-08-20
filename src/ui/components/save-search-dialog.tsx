import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogControl,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { BOARD_MAX, storedBoardQuery, type BoardSlots } from "../boards";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "update";
  defaultName: string;
  query: string;
  rangeLabel: string;
  rangeIsCustom: boolean;
  slotKeys: string[];
  defaultBoard: BoardSlots | null;
  onSave: (name: string, board: BoardSlots | null) => Promise<void>;
  onSaveAs?: (name: string, board: BoardSlots | null) => Promise<void>;
};

export function SaveSearchDialog({
  open,
  onOpenChange,
  mode,
  defaultName,
  query,
  rangeLabel,
  rangeIsCustom,
  slotKeys,
  defaultBoard,
  onSave,
  onSaveAs,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [boardOn, setBoardOn] = useState(Boolean(defaultBoard));
  const [keys, setKeys] = useState<string[]>(defaultBoard?.keys ?? []);
  const [win, setWin] = useState(defaultBoard?.win ?? false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setBoardOn(Boolean(defaultBoard));
      setKeys(defaultBoard?.keys ?? []);
      setWin(defaultBoard?.win ?? false);
    }
  }, [open, defaultName, defaultBoard]);

  const picked = keys.length + (win ? 1 : 0);
  const atCap = picked >= BOARD_MAX;
  const stored = boardOn ? storedBoardQuery(query, keys) : query;
  const board: BoardSlots | null =
    boardOn && (keys.length > 0 || win) ? { keys, win } : null;
  const canSubmit = name.trim().length > 0 && (!boardOn || board !== null);

  function toggleKey(key: string) {
    setKeys((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key);
      }
      if (prev.length + (win ? 1 : 0) >= BOARD_MAX) {
        return prev;
      }
      return [...prev, key];
    });
  }

  function toggleWin() {
    if (rangeIsCustom) {
      return;
    }
    setWin((prev) => {
      if (prev) {
        return false;
      }
      if (keys.length >= BOARD_MAX) {
        return false;
      }
      return true;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !canSubmit) {
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed, board);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function saveAs() {
    const trimmed = name.trim();
    if (!trimmed || !canSubmit || !onSaveAs) {
      return;
    }
    setSaving(true);
    try {
      await onSaveAs(trimmed, board);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "update" ? "Update saved search" : "Save search"}</DialogTitle>
          <DialogDescription>
            Names this query and range. Alerts watch saved searches.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <DialogField label="Name">
            <DialogControl>
              <input
                id="save-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Checkout 5xx"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          <DialogField
            label="Query"
            help={
              boardOn && keys.length > 0
                ? `Stored without ${keys.join(" and ")} — that token is lifted out and asked for on open.`
                : undefined
            }
          >
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {stored || "all logs"}
              </span>
            </DialogControl>
          </DialogField>
          <DialogField label="Range" help="Live keeps the window ending now.">
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {rangeLabel}
              </span>
            </DialogControl>
          </DialogField>
          <div className="rounded-[6.4px] border border-white/10 bg-accent/25 p-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[13px] font-medium">Board</span>
              <span
                className={`text-[11px] ${atCap && boardOn ? "text-amber-400" : "text-muted-foreground"}`}
              >
                {picked} of {BOARD_MAX} inputs
              </span>
              <Switch
                checked={boardOn}
                onCheckedChange={setBoardOn}
                aria-label="Make this saved search a board"
              />
            </div>
            <p className="mt-1.5 text-[11.5px] leading-snug text-pretty text-muted-foreground">
              {boardOn
                ? "Opens locked: only the inputs below can change. Ticked keys are lifted out of the stored query and asked for on open — so a board never carries two values of the same key."
                : "A board is this saved search, opened locked, with a few of its keys left live."}
            </p>
            {boardOn ? (
              <div className="mt-2 flex flex-col gap-px">
                {slotKeys.map((key) => {
                  const sel = keys.includes(key);
                  const blocked = !sel && atCap;
                  return (
                    <button
                      key={key}
                      type="button"
                      title={
                        blocked
                          ? `${BOARD_MAX} of ${BOARD_MAX} inputs — untick one to add another`
                          : sel
                            ? "lifted out of the query"
                            : "key in the query"
                      }
                      disabled={blocked}
                      className="flex h-7 items-center gap-2 rounded-[3.4px] px-1.5 text-left hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => toggleKey(key)}
                    >
                      <span
                        className={`flex size-3.5 items-center justify-center rounded-[3px] border text-[10px] ${
                          sel
                            ? "border-foreground bg-foreground text-background"
                            : "border-white/30"
                        }`}
                      >
                        {sel ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{key}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {sel ? "lifted out of the query" : "key in the query"}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  title={
                    rangeIsCustom
                      ? "A board window is a relative range — Quick or Last N only."
                      : !win && atCap
                        ? `${BOARD_MAX} of ${BOARD_MAX} inputs — untick one to add another`
                        : undefined
                  }
                  disabled={rangeIsCustom || (!win && atCap)}
                  className="flex h-7 items-center gap-2 rounded-[3.4px] px-1.5 text-left hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={toggleWin}
                >
                  <span
                    className={`flex size-3.5 items-center justify-center rounded-[3px] border text-[10px] ${
                      win
                        ? "border-foreground bg-foreground text-background"
                        : "border-white/30"
                    }`}
                  >
                    {win ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">window</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {rangeLabel} · relative only
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || !canSubmit} className="h-8">
              {mode === "update" ? "Update" : "Save"}
            </Button>
            {mode === "update" && onSaveAs ? (
              <Button
                type="button"
                variant="outline"
                className="h-8"
                disabled={saving || !canSubmit}
                onClick={() => void saveAs()}
              >
                Save as…
              </Button>
            ) : null}
            <span className="flex-1" />
            <DialogClose type="button">Cancel</DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
