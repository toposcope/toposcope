import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One sheet (sheet 45, Patterns → Overlays): a surface that slides from an edge for a task with
 * more fields than a dialog holds. `top` drops a centered, modal sheet under the header (Invite
 * someone, Make a token); `bottom` rises over the bottom of its container and leaves what is
 * above it live (Watch this); `left` and `right` hold the viewport's side. Esc closes it.
 */
export function Sheet({
  side,
  label,
  onClose,
  width,
  className,
  style,
  children,
}: {
  side: "top" | "bottom" | "left" | "right";
  label: string;
  onClose: () => void;
  /** top, left, right: its width in px; it never passes the viewport less 32px. */
  width?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const modal = side !== "bottom";
  return (
    <>
      {modal ? <div className="fixed inset-0 z-30 bg-black/55" aria-hidden="true" onClick={onClose} /> : null}
      <section
        role={modal ? "dialog" : "region"}
        aria-modal={modal || undefined}
        aria-label={label}
        data-slot="sheet"
        data-side={side}
        className={cn(
          "z-40 border-white/12 bg-surface-2",
          side === "top" &&
            "fixed top-16 left-1/2 flex max-h-[calc(100vh-96px)] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-y-auto rounded-xl border shadow-[0_30px_80px_rgba(0,0,0,.7)]",
          side === "bottom" && "absolute inset-x-0 bottom-0 z-30 border-t shadow-[0_-24px_60px_rgba(0,0,0,.6)]",
          side === "left" && "fixed inset-y-0 left-0 flex max-w-[calc(100vw-32px)] flex-col overflow-y-auto border-r shadow-lg",
          side === "right" && "fixed inset-y-0 right-0 flex max-w-[calc(100vw-32px)] flex-col overflow-y-auto border-l shadow-lg",
          className,
        )}
        style={{ ...(width && side !== "bottom" ? { width } : null), ...style }}
      >
        {children}
      </section>
    </>
  );
}
