import { Columns2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { PanelNote, PanelNoteField } from "@/components/panel-words";
import { WidgetCopyMenu } from "@/components/widget-copy-menu";
import { WidgetExportMenu } from "@/components/widget-export-menu";
import { AddToBoardList, type BoardChoice } from "@/components/add-to-board";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Panel, PanelArmed, PanelDots, PanelHead, PanelTitle, panelIconButton, panelMenuRow } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import {
  widgetExportFormats,
  type WidgetExportFormat,
} from "@/export-series";
import {
  extraHeadCollapsed,
  widgetTitle,
  type ExtraOverflowPage,
  type WidgetDef,
} from "../../shared/widgets";

type Props = {
  widget: WidgetDef;
  armed: boolean;
  atCap: boolean;
  moving: boolean;
  highlight?: boolean;
  lockChrome?: boolean;
  exportDisabled?: boolean;
  identity?: ReactNode;
  pct?: boolean;
  onPct?: (on: boolean) => void;
  onArm: () => void;
  onDisarm: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onCopy: (format: WidgetExportFormat) => void;
  onExport: (format: WidgetExportFormat) => void;
  onMovePointerDown: (e: PointerEvent) => void;
  /** Share… on every panel (#236, 24a): opens the Share dialog for this panel. */
  onShare?: () => void;
  /** Controls a panel kind puts in its head, before the actions: a metric panel's chart (#237, 25a). */
  headControls?: ReactNode;
  /** Add to board on the ⋯ menu (#410, 39e): copies this panel's query and view onto a board. */
  addToBoard?: { boards: BoardChoice[]; onPick: (boardId: string | null) => void };
  /** A note on any panel (sheet 44): Add note / Edit note on ⋯, the field under the head. */
  onNote?: (note: string) => void;
  /** Draw the note under the head; a metric panel says it in its body instead. */
  showNote?: boolean;
  children: ReactNode;
};

/** 24a: Share…, leading the panel's copy menu or its ⋯, on every panel. */
function ShareRow({ onShare, close }: { onShare: () => void; close: () => void }) {
  return (
    <button
      type="button"
      className="flex min-h-10 w-full flex-col items-start justify-center gap-0.5 rounded-sm bg-plate/[0.08] px-2 py-1 text-left text-sm hover:bg-plate/15"
      onClick={() => {
        close();
        onShare();
      }}
    >
      <span className="font-semibold">Share…</span>
      <span className="text-xs text-muted-foreground">show it on another site</span>
    </button>
  );
}

const dupCap = "Six panels is the cap — remove one to duplicate";

export const extraSelectClass =
  "h-[26px] min-w-0 rounded-md border border-input bg-overlay px-1 text-xs text-foreground";

const iconBtn = panelIconButton;

const overflowRow = cn(panelMenuRow, "gap-2");

function OverflowMenus({
  atCap,
  exportDisabled,
  onShare,
  onDuplicate,
  onCopy,
  onExport,
  addToBoard,
  noteLabel,
  onNoteEdit,
}: {
  noteLabel?: string;
  onNoteEdit?: () => void;
  atCap: boolean;
  exportDisabled?: boolean;
  onShare?: () => void;
  onDuplicate: () => void;
  onCopy: (format: WidgetExportFormat) => void;
  onExport: (format: WidgetExportFormat) => void;
  addToBoard?: Props["addToBoard"];
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ExtraOverflowPage | "board">("more");
  const keepFocus = useRef(false);

  function close() {
    setOpen(false);
    setPage("more");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPage("more");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={iconBtn}
          title={addToBoard ? "Duplicate, copy, export, add to board" : "Duplicate, copy, export"}
          aria-label="More panel actions"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PanelDots />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        // The note field takes focus; the menu does not hand it back to ⋯.
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) {
            e.preventDefault();
            keepFocus.current = false;
          }
        }}
        className={cn("bg-overlay p-1", (onShare && page === "more") || page === "board" ? "w-[210px]" : "w-[168px]")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {page === "more" ? (
          <>
            {onShare ? (
              <>
                <ShareRow onShare={onShare} close={close} />
                <div className="my-1 h-px bg-white/[0.08]" />
              </>
            ) : null}
            {onNoteEdit ? (
              <button
                type="button"
                className={overflowRow}
                onClick={() => {
                  keepFocus.current = true;
                  close();
                  onNoteEdit();
                }}
              >
                <span className="flex-1">{noteLabel}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={overflowRow}
              disabled={atCap}
              onClick={() => {
                close();
                if (!atCap) {
                  onDuplicate();
                }
              }}
            >
              <span className="flex-1">Duplicate</span>
              <span className="font-mono text-2xs text-muted-foreground">
                {atCap ? "at cap" : "⧉"}
              </span>
            </button>
            <button
              type="button"
              className={overflowRow}
              disabled={exportDisabled}
              onClick={() => setPage("copy")}
            >
              <span className="flex-1">Copy…</span>
              <span className="font-mono text-2xs text-muted-foreground">
                csv json svg png
              </span>
            </button>
            <button
              type="button"
              className={overflowRow}
              disabled={exportDisabled}
              onClick={() => setPage("export")}
            >
              <span className="flex-1">Export…</span>
              <span className="font-mono text-2xs text-muted-foreground">
                file
              </span>
            </button>
            {addToBoard ? (
              <>
                <div className="my-1 h-px bg-white/[0.08]" />
                <button type="button" className={overflowRow} onClick={() => setPage("board")}>
                  <span className="flex-1">Add to board</span>
                  <span className="text-2xs text-muted-foreground" aria-hidden>
                    ▸
                  </span>
                </button>
              </>
            ) : null}
          </>
        ) : page === "board" && addToBoard ? (
          <AddToBoardList boards={addToBoard.boards} onPick={addToBoard.onPick} close={close} />
        ) : (
          widgetExportFormats.map((format) => (
            <button
              key={format}
              type="button"
              className={overflowRow}
              onClick={() => {
                if (page === "copy") {
                  onCopy(format);
                } else {
                  onExport(format);
                }
                close();
              }}
            >
              <span className="flex-1">{format.toUpperCase()}</span>
              <span className="font-mono text-2xs text-muted-foreground">
                .{format}
              </span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ExtraPanel({
  widget,
  armed,
  atCap,
  moving,
  highlight,
  lockChrome = false,
  exportDisabled,
  identity,
  pct,
  onPct,
  onArm,
  onDisarm,
  onRemove,
  onDuplicate,
  onCopy,
  onExport,
  onMovePointerDown,
  onShare,
  headControls,
  addToBoard,
  onNote,
  showNote = true,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [noting, setNoting] = useState(false);
  useEffect(() => {
    if (noting) {
      noteRef.current?.querySelector("textarea")?.focus();
    }
  }, [noting]);
  const showPct = widget.kind === "hbar" && onPct;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const sync = () => setCollapsed(extraHeadCollapsed(el.clientWidth));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <Panel ref={rootRef} highlight={moving || highlight}>
      {armed ? (
        <PanelArmed name={widgetTitle(widget)} narrow={widget.w <= 2} onRemove={onRemove} onCancel={onDisarm} />
      ) : (
        <PanelHead
          className={cn(moving ? "cursor-grabbing" : "cursor-grab", lockChrome && "pointer-events-none opacity-50")}
          title="Drag to move · an edge to resize"
          onPointerDown={onMovePointerDown}
        >
          <div className="flex min-w-0 shrink items-center overflow-hidden">{identity ?? <PanelTitle>{widgetTitle(widget)}</PanelTitle>}</div>
          <span className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            {headControls}
            {collapsed || addToBoard || onNote ? (
              <OverflowMenus
                noteLabel={widget.note ? "Edit note" : "Add note"}
                onNoteEdit={onNote ? () => setNoting(true) : undefined}
                atCap={atCap}
                exportDisabled={exportDisabled}
                onShare={onShare}
                onDuplicate={onDuplicate}
                onCopy={onCopy}
                onExport={onExport}
                addToBoard={addToBoard}
              />
            ) : null}
            {showPct ? (
              <button
                type="button"
                className={cn(iconBtn, "text-xs", pct ? "bg-control text-foreground" : "")}
                title={pct ? "Hide shares" : "Show shares"}
                aria-label={pct ? "Hide shares" : "Show shares"}
                aria-pressed={pct}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onPct(!pct)}
              >
                %
              </button>
            ) : null}
            {collapsed ? null : (
              <>
                <button
                  type="button"
                  className={iconBtn}
                  disabled={atCap}
                  title={atCap ? dupCap : "Duplicate this panel"}
                  aria-label="Duplicate panel"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={onDuplicate}
                >
                  <Columns2 className="size-3" aria-hidden />
                </button>
                <WidgetCopyMenu
                  disabled={exportDisabled}
                  onCopy={onCopy}
                  header={onShare ? (close) => <ShareRow onShare={onShare} close={close} /> : undefined}
                />
                <WidgetExportMenu disabled={exportDisabled} onExport={onExport} />
              </>
            )}
            <button
              type="button"
              className={cn(iconBtn, "text-base leading-none")}
              title="Remove panel"
              aria-label="Remove widget"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onArm}
            >
              ×
            </button>
          </div>
        </PanelHead>
      )}
      {noting && onNote ? (
        <div
          ref={noteRef}
          className="shrink-0"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setNoting(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              setNoting(false);
            }
          }}
        >
          <PanelNoteField widget={widget} onNote={onNote} />
        </div>
      ) : showNote && widget.note ? (
        <PanelNote note={{ text: widget.note, sender: false }} leftOff={[]} />
      ) : null}
      {children}
    </Panel>
  );
}
