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
};

export function WidgetFormatMenu({
  disabled,
  title,
  ariaLabel,
  trigger,
  onPick,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-[22px] text-muted-foreground hover:text-foreground"
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
        className="min-w-[8rem] bg-[#18181b] p-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {widgetExportFormats.map((format) => (
          <button
            key={format}
            type="button"
            className="flex h-[26px] w-full items-center gap-2.5 rounded-[3.4px] px-[7px] text-left text-[12.5px] hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onPick(format);
            }}
          >
            <span className="flex-1">{format.toUpperCase()}</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              .{format}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
