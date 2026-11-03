import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * An in-place confirm, never a dialog (sheet 45): the first click arms it ("revoke" becomes
 * "sure? revoke" in danger), the second does it. Focus moves to the armed control; Esc disarms.
 * `text` sits in a row; `button` is an outline Button in a toolbar.
 */
export function Armed({
  armed,
  onArm,
  onDisarm,
  onConfirm,
  label,
  confirm,
  form = "text",
  title,
  className,
}: {
  armed: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onConfirm: () => void;
  label: React.ReactNode;
  confirm: React.ReactNode;
  form?: "text" | "button";
  title?: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const disarm = React.useRef(onDisarm);
  disarm.current = onDisarm;
  React.useEffect(() => {
    if (!armed) {
      return;
    }
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        disarm.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);
  if (form === "button") {
    return (
      <Button ref={ref} type="button" variant="outline" className={cn(className, armed && "text-danger-fg")} title={title} onClick={armed ? onConfirm : onArm}>
        {armed ? confirm : label}
      </Button>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      className={cn(
        "rounded-sm text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        armed ? "text-danger-fg hover:underline" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={armed ? onConfirm : onArm}
    >
      {armed ? confirm : label}
    </button>
  );
}
