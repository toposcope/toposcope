import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { rankHeadOptions } from "../head-query";

const FN = "#a78bfa";

type Item = { value: string; label: string };

type Props = {
  kind: "function" | "value";
  label: string;
  title: string;
  value: string;
  items: Item[];
  used?: readonly string[];
  pre?: string;
  post?: string;
  onChange: (value: string) => void;
};

export function HeadPicker({
  kind,
  label,
  title,
  value,
  items,
  used = [],
  pre,
  post,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const fn = kind === "function";
  const ranked = rankHeadOptions(items, value, used);
  return (
    <>
      {pre ? (
        <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
          {pre}
        </span>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={`${label} — ${title}`}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex max-w-full items-center border-none px-px font-mono text-[11.5px] leading-[1.55] outline-none",
              fn
                ? "shrink-0 whitespace-nowrap"
                : "min-w-0 flex-1 truncate",
            )}
            style={{
              color: fn ? FN : "oklch(0.985 0 0)",
              borderBottom: `1px dashed ${
                open
                  ? fn
                    ? FN
                    : "oklch(0.985 0 0)"
                  : fn
                    ? `${FN}85`
                    : "oklch(1 0 0 / 34%)"
              }`,
              background: open
                ? fn
                  ? `${FN}26`
                  : "oklch(1 0 0 / 10%)"
                : "transparent",
              borderRadius: 2,
            }}
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-[182px] bg-[#18181b] p-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="mb-0.5 border-b border-white/[0.08] px-[7px] pt-1 pb-[5px] text-[9.5px] tracking-[0.1em] uppercase"
            style={{ color: fn ? FN : "oklch(0.705 0.015 286.067)" }}
          >
            {fn ? "Function" : "Value"}
          </div>
          {ranked.map((item) => {
            const on = item.value === value;
            return (
              <button
                key={item.value}
                type="button"
                className={cn(
                  "flex h-[25px] w-full items-center gap-[7px] rounded-[3.4px] px-[7px] text-left font-mono text-[11.5px]",
                  on ? "bg-accent" : "bg-transparent hover:bg-accent",
                  item.used && "text-muted-foreground",
                )}
                onClick={() => {
                  setOpen(false);
                  onChange(item.value);
                }}
              >
                <span
                  className="w-[9px] shrink-0 text-[10px]"
                  style={{
                    color: on ? (fn ? FN : "oklch(0.985 0 0)") : undefined,
                    opacity: on ? 1 : 0,
                  }}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.used ? (
                  <span className="shrink-0 text-[9.5px] tracking-[0.03em] text-muted-foreground/75">
                    on canvas
                  </span>
                ) : null}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {post ? (
        <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
          {post}
        </span>
      ) : null}
    </>
  );
}
