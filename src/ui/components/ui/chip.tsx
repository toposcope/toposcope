import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A facet value or a toggle that writes `q` (sheet 45). `aria-pressed` carries the on state;
 * the count is part of the name. Colour changes only; counts swap in place.
 */
const chipVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:border-zinc-400 aria-pressed:text-foreground cursor-pointer [&_svg]:shrink-0",
  {
    variants: {
      size: {
        xs: "h-4.5 gap-1 rounded-sm px-1.5 text-2xs [&_svg]:size-3",
        sm: "h-5.5 px-2 text-xs [&_svg]:size-3",
        md: "h-6.5 px-2.5 text-sm [&_svg]:size-3.5",
        lg: "h-7.5 px-3 text-sm [&_svg]:size-3.5",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

function Chip({ className, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof chipVariants>) {
  return <button type="button" data-slot="chip" className={cn(chipVariants({ size }), className)} {...props} />;
}

export { Chip, chipVariants };
