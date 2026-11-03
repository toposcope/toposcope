import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The chevron is a menu trigger as tall as the action and about half as wide as a square one. */
const chevronWidth = { xs: "w-4", sm: "w-4.5", md: "w-5.5", lg: "w-6" } as const;

/**
 * One action and its menu (sheet 45: Save ▾ on a hunt and a board). One height and one radius:
 * the action keeps the left corners, the chevron the right ones.
 */
export function SplitButton(props: {
  children: React.ReactNode;
  onClick: () => void;
  /** The chevron's accessible name. */
  menuLabel: string;
  menu: React.ReactNode;
  size?: keyof typeof chevronWidth;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  disabled?: boolean;
  className?: string;
}) {
  const size = props.size ?? "md";
  return (
    <div className={cn("flex", props.className)}>
      <Button type="button" size={size} variant={props.variant ?? "outline"} className="rounded-r-none border-r-0" disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size={size} variant={props.variant ?? "outline"} className={cn("rounded-l-none px-0 text-muted-foreground", chevronWidth[size])} aria-label={props.menuLabel}>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{props.menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
