import { Ellipsis } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { maxBoardName, boardMenuItems, type BoardMenuItem } from "../board-menu";

/**
 * A board's head (sheet 49, 49d): Home › its name, which is renamed in place, how many panels it
 * has and the window it follows (50e), `pinned` when it is on Home; then whether its changes are
 * saved, Share and the board's ⋯ menu (49g, 50e).
 */
export function BoardHead(props: {
  name: string;
  /** Panels that read rows: headings and notes are not counted. */
  panels: number;
  pinned: boolean;
  /** The board's window differs from the one it saved. */
  dirty: boolean;
  /** `Last 24h`: the window the board's panels follow. */
  winLabel: string;
  /** A Viewer: no rename, no Save, no menu. */
  readOnly: boolean;
  onHome: () => void;
  onRename: (name: string) => void;
  onSave: () => void;
  onShare: () => void;
  onDuplicate: () => void;
  onFit: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [armed, setArmed] = useState(false);
  const renameNext = useRef(false);
  const run: Record<BoardMenuItem["id"], () => void> = {
    rename: () => {
      renameNext.current = true;
      setRenaming(true);
    },
    fit: props.onFit,
    duplicate: props.onDuplicate,
    pin: props.onPin,
    delete: props.onDelete,
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-sm">
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onHome}>
        Home
      </button>
      <span className="text-faint" aria-hidden="true">
        ›
      </span>
      {renaming ? (
        <BoardNameField
          value={props.name}
          onDone={(name) => {
            setRenaming(false);
            if (name && name !== props.name) {
              props.onRename(name);
            }
          }}
        />
      ) : props.readOnly ? (
        <span className="max-w-[420px] truncate font-semibold text-foreground">{props.name}</span>
      ) : (
        <button
          type="button"
          title="Rename"
          className="h-6.5 max-w-[420px] truncate rounded-md border border-transparent px-1.5 font-semibold text-foreground hover:border-input focus-visible:border-foreground/40 focus-visible:outline-none"
          onClick={() => setRenaming(true)}
        >
          {props.name}
        </button>
      )}
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
        {props.panels} {props.panels === 1 ? "panel" : "panels"}
      </span>
      <span className="min-w-0 truncate font-mono text-xs whitespace-nowrap text-muted-foreground">· the board's window, {props.winLabel}</span>
      {props.pinned ? <span className="rounded-sm border border-plate/40 px-1.5 text-xs leading-[18px] text-plate">pinned</span> : null}
      <div className="flex-1" />
      {props.readOnly ? null : props.dirty ? (
        <>
          <span className="font-mono text-xs whitespace-nowrap text-faint">unsaved</span>
          <Button type="button" variant="outline" onClick={props.onSave}>
            Save
          </Button>
        </>
      ) : (
        <span className="font-mono text-xs whitespace-nowrap text-faint">all changes saved</span>
      )}
      <Button type="button" variant="outline" onClick={props.onShare}>
        Share
      </Button>
      {props.readOnly ? null : (
        <DropdownMenu onOpenChange={(open) => !open && setArmed(false)}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Board menu" className="data-[state=open]:border-plate/60 data-[state=open]:bg-plate/10">
              <Ellipsis aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[250px]"
            // Rename puts the caret in the name: the menu does not hand focus back to ⋯.
            onCloseAutoFocus={(e) => {
              if (renameNext.current) {
                e.preventDefault();
                renameNext.current = false;
              }
            }}
          >
            {boardMenuItems(props.pinned).map((item) =>
              item.id === "delete" ? (
                <Fragment key={item.id}>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-danger-fg focus:text-danger-fg"
                    onSelect={(e) => {
                      if (!armed) {
                        // The first pick arms it in place (sheet 45: never a dialog); the second deletes.
                        e.preventDefault();
                        setArmed(true);
                        return;
                      }
                      run.delete();
                    }}
                  >
                    {armed ? `Sure? Delete ${props.name}` : item.label}
                  </DropdownMenuItem>
                </Fragment>
              ) : (
                <DropdownMenuItem key={item.id} className={item.sub ? "h-auto flex-col items-start gap-0 py-1.5" : undefined} onSelect={run[item.id]}>
                  <span>{item.label}</span>
                  {item.sub ? <span className="text-xs font-normal text-muted-foreground">{item.sub}</span> : null}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The board's name typed in place: Enter or leaving keeps it, Escape drops it. */
function BoardNameField({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) {
      return;
    }
    done.current = true;
    const name = draft.replace(/\s+/g, " ").trim();
    onDone(keep && name ? name : null);
  };
  return (
    <input
      aria-label="Board name"
      value={draft}
      maxLength={maxBoardName}
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      className={cn(
        "h-6.5 w-[260px] min-w-0 rounded-md border border-plate/60 bg-background px-1.5 text-sm font-semibold outline-none focus-visible:border-foreground/40",
      )}
    />
  );
}
