import type { ReactNode } from "react";

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <kbd>{k}</kbd>
      {label}
    </span>
  );
}

type Props = {
  children: ReactNode;
};

export function StatusFooter({ children }: Props) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-2.5 border-t bg-background px-3 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        <Hint k="/" label="search" />
        <Hint k="↑↓←→" label="focus" />
        <Hint k="wheel / + −" label="zoom" />
        <Hint k="esc" label="close" />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </footer>
  );
}
