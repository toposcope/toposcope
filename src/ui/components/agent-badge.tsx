import { createContext, useContext } from "react";
import { cn } from "@/lib/utils";

/** What a badge does when clicked, for a view whose rows wear many: Watch opens Access with it. */
export const OpenAgent = createContext<(() => void) | undefined>(undefined);

/**
 * "✦ agent: claude" (#357, 34c): worn by what an agent saved, wherever its maker shows. With
 * `onOpen`, or inside an `OpenAgent`, it opens the agent's row in Access; it sits inside rows that open something else.
 */
export function AgentBadge(props: { name: string; onOpen?: () => void; className?: string }) {
  const fromView = useContext(OpenAgent);
  const open = props.onOpen ?? fromView;
  return (
    <span
      role={open ? "link" : undefined}
      tabIndex={open ? 0 : undefined}
      title={open ? `${props.name} · open its row in Access` : `saved by ${props.name}`}
      className={cn(
        "inline-flex h-[18px] max-w-[180px] shrink-0 items-center gap-[5px] rounded-[5px] border border-[#4b4560] bg-[#17151f] px-[7px] font-mono text-[10.5px] whitespace-nowrap text-[#c4b5fd]",
        open && "cursor-pointer hover:border-[#6d62a0]",
        props.className,
      )}
      onClick={
        open
          ? (e) => {
              e.stopPropagation();
              open();
            }
          : undefined
      }
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                open();
              }
            }
          : undefined
      }
    >
      <span aria-hidden="true">✦</span>
      <span className="truncate">{props.name}</span>
    </span>
  );
}
