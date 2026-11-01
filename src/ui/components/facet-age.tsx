import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { facetAgeView } from "../live-updated";

type Props = {
  /** Read on every tick: when the chip row's oldest list last landed. */
  fetchedAt: () => number | undefined;
  /** Live is paused while an event is open (#261): the age counts on, but is not a missed pass. */
  paused: boolean;
};

/**
 * Frame 36c: in Live the chip row leads with how old its counts are, its own group before level.
 * The counts refresh on the 30s pass while the clock moves every 2s; this is that lag, named.
 */
export function FacetAge({ fetchedAt, paused }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const view = facetAgeView(fetchedAt(), now, paused);
  if (!view) {
    return null;
  }
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "group inline-flex h-[26px] items-center gap-[5px] font-mono text-[11px] tabular-nums",
            view.overdue ? "text-plate" : "text-muted-foreground hover:text-foreground",
          )}
          aria-label={view.tip}
          data-facet-age=""
        >
          <RotateCw className="size-3" aria-hidden />
          <span className="decoration-dotted underline-offset-[3px] group-hover:underline">{view.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="border bg-popover px-[9px] py-1.5 text-[12px] text-popover-foreground">
        {view.tip}
      </TooltipContent>
    </Tooltip>
  );
}
