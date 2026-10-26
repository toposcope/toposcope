import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  onWatch: () => void;
  onShare: () => void;
}) {
  const state = props.name ? (props.dirty ? "saved · edited" : "saved") : "not saved";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2.5 text-[13px]">
      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onHome}>
        Home
      </button>
      <span className="text-zinc-600" aria-hidden="true">
        ›
      </span>
      <span className="max-w-[420px] truncate font-medium text-foreground">{props.name ?? "hunt"}</span>
      {props.mark ? (
        <span className="ml-1.5 inline-flex h-6 items-center gap-1.5 rounded-[6.4px] border border-plate bg-[#141416] pr-1 pl-[9px] text-[12px] whitespace-nowrap">
          <span style={{ color: markGlyph[props.mark.kind].color }}>{markGlyph[props.mark.kind].glyph}</span>
          <span className="max-w-[280px] truncate">since {props.mark.title}</span>
          <b className="font-mono text-[11.5px] font-medium text-muted-foreground">{hhmmUtc(props.mark.ts)}</b>
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
      <span className="font-mono text-[11.5px] text-muted-foreground">{state}</span>
      <div className={cn("flex", props.saveDisabled && !props.board && "pointer-events-none opacity-45")}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-r-none border-r-0"
          title={props.board ? "Edit this board — its template, window and inputs" : undefined}
          disabled={props.saveDisabled && !props.board}
          onClick={props.onSave}
        >
          Save
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="h-8 w-7 rounded-l-none px-0 text-muted-foreground" aria-label="More saving">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={props.saveDisabled} onSelect={props.onSaveAs}>
              Save as…
            </DropdownMenuItem>
            {props.onPin ? <DropdownMenuItem onSelect={props.onPin}>{props.pinned ? "Unpin from Home" : "Pin to Home"}</DropdownMenuItem> : null}
            {props.onDelete ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border" role="separator" />
                <DropdownMenuItem className="text-red-300" onSelect={props.onDelete}>
                  Delete this saved hunt
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={props.board} onClick={props.onWatch}>
        Watch this
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={props.onShare}>
        Share
      </Button>
    </div>
  );
}
