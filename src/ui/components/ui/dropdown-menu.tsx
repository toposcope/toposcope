import * as React from "react";
import { ChevronRight } from "lucide-react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { overlayMotion } from "@/components/ui/motion";

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border border-white/12 bg-overlay p-1 text-popover-foreground shadow-[0_12px_28px_oklch(0_0_0_/_55%)]",
          overlayMotion,
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex h-[26px] cursor-pointer select-none items-center rounded-sm px-1.5 text-sm outline-none focus:bg-control focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function DropdownMenuSub(props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

/** A row that opens a menu beside it (49e, From a saved hunt ›). */
function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex h-[26px] cursor-pointer select-none items-center gap-2 rounded-sm px-1.5 text-sm outline-none focus:bg-control data-[state=open]:bg-control data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, collisionPadding = 8, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 min-w-32 overflow-hidden rounded-lg border border-white/12 bg-overlay p-1 text-popover-foreground shadow-[0_12px_28px_oklch(0_0_0_/_55%)]",
          overlayMotion,
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
