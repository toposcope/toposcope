import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import { cn } from "@/lib/utils";
import type { ChangeMark } from "../../shared/change-mark";
import { hhmmUtc, markGlyph } from "../home-since";

/**
 * The hunt's crumb row (frame 26d, #260): Home › the saved hunt, the carried mark, and the hunt's
 * own verbs as words: Save, Watch this, Share. Saved hunts are listed on Home, so this row's Save
 * menu is where one is pinned, renamed or deleted.
 */
export function HuntCrumb(props: {
  name: string | null;
  board: boolean;
  /** `board · 6 panels` beside a board's name (39b). */
  badge?: string;
  dirty: boolean;
  pinned: boolean;
  mark: ChangeMark | null;
  saveDisabled: boolean;
  onHome: () => void;
  onCloseMark: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onPin: (() => void) | null;
  onDelete: (() => void) | null;
  /** Null for a Viewer, who makes no monitors (30e). */
  onWatch: (() => void) | null;
  onShare: () => void;
}) {
  const state = props.name ? (props.dirty ? "saved · edited" : "saved") : "not saved";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2.5 text-sm">
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onHome}>
        Home
      </button>
      <span className="text-zinc-600" aria-hidden="true">
        ›
      </span>
      <span className="max-w-[420px] truncate font-medium text-foreground">{props.name ?? "hunt"}</span>
      {props.badge ? (
        <span className="rounded-md border border-white/15 px-1.5 font-mono text-xs leading-[19px] text-muted-foreground">
          {props.badge}
        </span>
      ) : null}
      {props.mark ? (
        <span className="ml-1.5 inline-flex h-6 items-center gap-1.5 rounded-lg border border-plate bg-surface-2 pr-1 pl-[9px] text-sm whitespace-nowrap">
          <span style={{ color: markGlyph[props.mark.kind].color }}>{markGlyph[props.mark.kind].glyph}</span>
          <span className="max-w-[280px] truncate">since {props.mark.title}</span>
          <b className="font-mono text-xs font-medium text-muted-foreground">{hhmmUtc(props.mark.ts)}</b>
          <button
            type="button"
            className="flex size-[18px] items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            title="Close Compare"
            aria-label="Close Compare"
            onClick={props.onCloseMark}
          >
            <X className="size-3" />
          </button>
        </span>
      ) : null}
      <div className="flex-1" />
      <span className="font-mono text-xs text-muted-foreground">{state}</span>
      <SplitButton
        className={cn(props.saveDisabled && !props.board && "pointer-events-none opacity-45")}
        disabled={props.saveDisabled && !props.board}
        onClick={props.onSave}
        menuLabel="More saving"
        menu={
          <>
            <DropdownMenuItem disabled={props.saveDisabled} onSelect={props.onSaveAs}>
              Save as…
            </DropdownMenuItem>
            {props.onPin ? <DropdownMenuItem onSelect={props.onPin}>{props.pinned ? "Unpin from Home" : "Pin to Home"}</DropdownMenuItem> : null}
            {props.onDelete ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border" role="separator" />
                <DropdownMenuItem className="text-danger-fg" onSelect={props.onDelete}>
                  {props.board ? "Delete this board" : "Delete this saved hunt"}
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        }
      >
        Save
      </SplitButton>
      {props.onWatch ? (
        <Button type="button" variant="outline" disabled={props.board} onClick={props.onWatch}>
          Watch this
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={props.onShare}>
        Share
      </Button>
    </div>
  );
}

/**
 * An Edit panel tab's crumb row (#410, 39f): Home › the board › Edit panel, then Cancel and
 * Update panel in place of Save, Watch this and Share.
 */
export function EditPanelCrumb(props: {
  boardName: string;
  panelName: string;
  updateDisabled: boolean;
  onHome: () => void;
  onBoard: () => void;
  onCancel: () => void;
  onUpdate: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2.5 text-sm">
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onHome}>
        Home
      </button>
      <span className="text-zinc-600" aria-hidden="true">
        ›
      </span>
      <button type="button" className="max-w-[320px] truncate text-muted-foreground hover:text-foreground" onClick={props.onBoard}>
        {props.boardName}
      </button>
      <span className="text-zinc-600" aria-hidden="true">
        ›
      </span>
      <span className="font-medium text-foreground">Edit panel</span>
      <span className="max-w-[320px] truncate text-muted-foreground">{props.panelName}</span>
      <div className="flex-1" />
      <span className="text-sm text-muted-foreground">Board inputs are off while you edit.</span>
      <Button type="button" variant="outline" onClick={props.onCancel}>
        Cancel
      </Button>
      <Button type="button" disabled={props.updateDisabled} onClick={props.onUpdate}>
        Update panel
      </Button>
    </div>
  );
}
