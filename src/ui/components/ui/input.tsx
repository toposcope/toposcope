import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Same heights as Button (sheet 45); the query bar is lg. */
const inputVariants = cva(
  "flex w-full rounded-md border border-input bg-transparent py-1 transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        xs: "h-4.5 rounded-sm px-1.5 text-2xs",
        sm: "h-5.5 px-2 text-xs",
        md: "h-6.5 px-2.5 text-sm",
        lg: "h-7.5 px-2.5 text-sm",
      },
    },
    defaultVariants: { size: "md" },
  },
);

function Input({ className, type, size, ...props }: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return <input type={type} data-slot="input" className={cn(inputVariants({ size }), className)} {...props} />;
}

export { Input, inputVariants };
