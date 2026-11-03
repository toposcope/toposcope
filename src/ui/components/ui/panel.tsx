import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One panel shell for hunts and boards (sheet 45, Patterns → Panel): a `lg 30` head on
 * `surface-2` over a `surface-1` body. Each place keeps its own ⋯ items.
 */
export function Panel({
  lifted = false,
  highlight = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** Picked up by a drag: plate edge and a shadow. */
  lifted?: boolean;
  /** Moving, or just added: the ring edge. */
  highlight?: boolean;
}) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "group/panel flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-surface-1 transition-[box-shadow,border-color] duration-500",
        lifted ? "border-plate/55 shadow-[0_14px_36px_rgb(0_0_0/0.55)]" : highlight ? "border-ring" : "border-white/10",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The head: title, query and value, then the icon buttons. A drag starts here. */
export function PanelHead({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-head"
      className={cn("flex h-7.5 shrink-0 touch-none items-center gap-1.5 overflow-hidden border-b border-white/[0.08] bg-surface-2 pr-1 pl-3", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 shrink truncate text-sm font-semibold", className)} {...props} />;
}

export function PanelQuery({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 shrink truncate font-mono text-xs text-muted-foreground", className)} {...props} />;
}

export function PanelValue({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground", className)} {...props} />;
}

/** An icon button in the head: `icon-sm 22`, named for screen readers. */
export const panelIconButton =
  "flex size-5.5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-control data-[state=open]:text-foreground";

/** A row on a panel's ⋯ menu: `md 26`. */
export const panelMenuRow =
  "flex h-6.5 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-control focus-visible:bg-control focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45";

export function PanelDots() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/**
 * Remove, armed in the head (never a dialog): "Remove *name*?" · Remove · Cancel. Esc cancels.
 * A panel too narrow for words keeps Remove and an ×.
 */
export function PanelArmed({ name, narrow = false, onRemove, onCancel }: { name: string; narrow?: boolean; onRemove: () => void; onCancel: () => void }) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const cancel = React.useRef(onCancel);
  cancel.current = onCancel;
  React.useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <PanelHead className="bg-danger-soft" role="alertdialog" aria-label={`Remove ${name}?`}>
      {narrow ? null : (
        <span className="min-w-0 truncate text-sm text-danger-fg">
          Remove <i>{name}</i>?
        </span>
      )}
      <span className="min-w-0 flex-1" />
      <Button size="sm" type="button" variant="destructive" className="min-w-0 shrink-0" onPointerDown={stop} onClick={onRemove}>
        Remove
      </Button>
      <Button
        ref={cancelRef}
        size="sm"
        type="button"
        variant="outline"
        className="min-w-0 shrink-0"
        title="Keep this panel"
        aria-label="Keep this panel"
        onPointerDown={stop}
        onClick={onCancel}
      >
        {narrow ? "×" : "Cancel"}
      </Button>
    </PanelHead>
  );
}
