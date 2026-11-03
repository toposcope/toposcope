import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/50", className)}
      {...props}
    />
  );
}

/** Sheet 45: three widths. sm 440 (save, board name) · md 640 (links, shares) · lg 1080 (monitors). */
const dialogWidth = {
  sm: "max-w-[min(440px,calc(100vw-32px))]",
  md: "max-w-[min(640px,calc(100vw-32px))]",
  lg: "max-w-[min(1080px,calc(100vw-32px))]",
} as const;

function DialogContent({
  className,
  children,
  size = "sm",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { size?: keyof typeof dialogWidth }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-0 rounded-xl border border-white/12 bg-overlay p-[18px] shadow-[0_20px_50px_oklch(0_0_0_/_55%)]",
          dialogWidth[size],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mb-3.5 flex flex-col gap-1 text-left", className)} {...props} />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-semibold tracking-[-0.01em]", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm leading-[1.5] text-muted-foreground", className)}
      {...props}
    />
  );
}

/** One footer (sheet 45): right-aligned, Cancel then the one primary; a destructive primary is danger. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mt-4 flex items-center justify-end gap-2", className)} {...props} />
  );
}

function DialogClose({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      className={cn(
        "h-7.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

function DialogField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {help ? (
        <span className="text-xs text-muted-foreground">{help}</span>
      ) : null}
    </div>
  );
}

function DialogControl({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md border border-input px-[9px] focus-within:border-foreground/40",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogControl,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
