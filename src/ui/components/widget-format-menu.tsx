import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { WidgetExportFormat } from "@/export-series";
import { widgetExportFormats } from "@/export-series";

type Props = {
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  trigger: ReactNode;
  onPick: (format: WidgetExportFormat) => void;
  /** Rows after the formats, under a rule; given `close`. */
  footer?: (close: () => void) => ReactNode;
  /** Rows before the formats, above a rule (Share…, #236); given `close`. */
  header?: (close: () => void) => ReactNode;
};

export function WidgetFormatMenu({
  disabled,
  title,
  ariaLabel,
  trigger,
  onPick,
  footer,
  header,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-sm"
          type="button"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          disabled={disabled}
          title={title}
          aria-label={ariaLabel}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {trigger}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="min-w-[8rem] bg-overlay p-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {header ? (
          <>
            {header(() => setOpen(false))}
            <div className="my-1 h-px bg-white/[0.08]" />
          </>
        ) : null}
        {widgetExportFormats.map((format) => (
          <button
            key={format}
            type="button"
            className="flex h-[26px] w-full items-center gap-2 rounded-sm px-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onPick(format);
            }}
          >
            <span className="flex-1">{format.toUpperCase()}</span>
            <span className="font-mono text-2xs text-muted-foreground">
              .{format}
            </span>
          </button>
        ))}
        {footer ? (
          <>
            <div className="my-1 h-px bg-white/[0.08]" />
            {footer(() => setOpen(false))}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
