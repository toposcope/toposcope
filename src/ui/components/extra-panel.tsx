import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { WidgetCopyMenu } from "@/components/widget-copy-menu";
import { WidgetExportMenu } from "@/components/widget-export-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  children: ReactNode;
};

const dupCap = "Six panels is the cap — remove one to duplicate";

export const extraSelectClass =
  "h-[26px] min-w-0 rounded-md border border-input bg-[#18181b] px-[5px] text-[11.5px] text-foreground";

const iconBtn =
  "flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

const overflowRow =
  "flex h-[26px] w-full items-center gap-2.5 rounded-[3.4px] px-2 text-left text-[12.5px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45";

function OverflowMenus({
  atCap,
  exportDisabled,
  onDuplicate,
  onCopy,
  onExport,
}: {
  atCap: boolean;
  exportDisabled?: boolean;
  onDuplicate: () => void;
  onCopy: (format: WidgetExportFormat) => void;
  onExport: (format: WidgetExportFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ExtraOverflowPage>("more");

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
          title="Duplicate, copy, export"
          aria-label="More panel actions"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-[168px] bg-[#18181b] p-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {page === "more" ? (
          <>
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
              <span className="font-mono text-[10px] text-muted-foreground">
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
              <span className="font-mono text-[10px] text-muted-foreground">
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
              <span className="font-mono text-[10px] text-muted-foreground">
                file
              </span>
            </button>
          </>
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
              <span className="font-mono text-[10.5px] text-muted-foreground">
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
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
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
    <div
      ref={rootRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card transition-[box-shadow,border-color] duration-500",
        moving || highlight ? "border-ring" : "border-white/10",
      )}
    >
      <div
        className={cn(
          "flex h-[30px] shrink-0 touch-none items-center gap-2 overflow-hidden rounded-t-[5.4px] border-b border-white/[0.08] pr-1 pl-3",
          armed ? "bg-destructive/14" : "bg-background/45",
          moving ? "cursor-grabbing" : "cursor-grab",
          lockChrome && "pointer-events-none opacity-50",
        )}
        title="Drag to move · corner to resize"
        onPointerDown={onMovePointerDown}
      >
        {armed ? (
          <>
            {widget.w > 2 ? (
              <span className="min-w-0 truncate text-[11.5px] text-red-300">
                Remove?
              </span>
            ) : null}
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              className="h-[22px] min-w-0 truncate rounded-md border border-destructive/55 bg-destructive/16 px-[9px] text-[11.5px] text-red-300 hover:bg-destructive/26"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onRemove}
            >
              Remove
            </button>
            <button
              type="button"
              className="h-[22px] min-w-0 truncate rounded-md border border-input px-2 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Keep this panel"
              aria-label="Keep this panel"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onDisarm}
            >
              {widget.w <= 2 ? "×" : "Cancel"}
            </button>
          </>
        ) : (
          <>
            <div className="flex min-w-0 shrink items-center overflow-hidden">
              {identity ?? (
                <span className="min-w-0 truncate font-mono text-[11.5px]">
                  {widgetTitle(widget)}
                </span>
              )}
            </div>
            <span className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center">
              {collapsed ? (
                <OverflowMenus
                  atCap={atCap}
                  exportDisabled={exportDisabled}
                  onDuplicate={onDuplicate}
                  onCopy={onCopy}
                  onExport={onExport}
                />
              ) : null}
              {showPct ? (
                <button
                  type="button"
                  className={cn(
                    iconBtn,
                    "text-[11px]",
                    pct ? "bg-accent text-foreground" : "",
                  )}
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
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <rect x="3" y="5" width="8" height="14" rx="1.6" />
                      <rect x="13" y="5" width="8" height="14" rx="1.6" opacity="0.5" />
                    </svg>
                  </button>
                  <WidgetCopyMenu disabled={exportDisabled} onCopy={onCopy} />
                  <WidgetExportMenu disabled={exportDisabled} onExport={onExport} />
                </>
              )}
              <button
                type="button"
                className="size-[22px] rounded-md text-[14px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Remove panel"
                aria-label="Remove widget"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onArm}
              >
                ×
              </button>
            </div>
          </>
        )}
      </div>
      {children}
    </div>
  );
}
