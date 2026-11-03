import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-sans text-sm font-medium transition-[color,background-color,border-color,transform] duration-(--duration-1) ease-(--ease-out) active:scale-97 aria-busy:cursor-progress focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-white",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      /** Sheet 45: xs 18 in a row, sm 22 in panel heads, md 26 in toolbars, lg 30 in the query bar. */
      size: {
        xs: "h-4.5 gap-1 rounded-sm px-1.5 text-2xs [&_svg]:size-3",
        sm: "h-5.5 gap-1 px-2 text-xs [&_svg]:size-3",
        md: "h-6.5 px-2.5 [&_svg]:size-3.5",
        lg: "h-7.5 px-3 [&_svg]:size-3.5",
        icon: "size-6.5 [&_svg]:size-3.5",
        "icon-sm": "size-5.5 [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  busy = false,
  children,
  onClick,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Working: `aria-busy`, a spinner, clicks swallowed, focus kept (not `disabled`). */
    busy?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  const label = useLabelMotion(asChild ? null : children);
  return (
    <Comp
      data-slot="button"
      aria-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={
        busy
          ? (e: React.MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
            }
          : onClick
      }
      {...label.props}
      {...props}
    >
      {busy ? <span aria-hidden className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current motion-reduce:animate-[spin_2.4s_linear_infinite]" /> : null}
      {label.node}
    </Comp>
  );
}

/**
 * A label that changes (Save hunt → Saved) fades in while the button's width eases from the old
 * label's to the new one's (`--duration-2`). Only a plain-text label moves.
 */
function useLabelMotion(children: React.ReactNode): { node: React.ReactNode; props: { ref?: React.Ref<HTMLButtonElement> } } {
  const ref = React.useRef<HTMLButtonElement>(null);
  const text = typeof children === "string" ? children : null;
  const first = React.useRef(text);
  const last = React.useRef<{ text: string | null; width: number }>({ text, width: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || text === null) {
      return;
    }
    const before = last.current;
    const width = el.getBoundingClientRect().width;
    last.current = { text, width };
    if (before.text === null || before.text === text || before.width === 0 || before.width === width) {
      return;
    }
    el.style.width = `${before.width}px`;
    el.getBoundingClientRect();
    el.style.transition = "width var(--duration-2) var(--ease-out)";
    el.style.width = `${width}px`;
    const done = () => {
      el.style.width = "";
      el.style.transition = "";
    };
    el.addEventListener("transitionend", done, { once: true });
    const timer = window.setTimeout(done, 400);
    return () => window.clearTimeout(timer);
  }, [text]);
  if (text === null) {
    return { node: children, props: {} };
  }
  return {
    node: (
      <span key={text} className={text === first.current ? undefined : "animate-in fade-in-0 duration-(--duration-2)"}>
        {text}
      </span>
    ),
    props: { ref },
  };
}

export { Button, buttonVariants };
