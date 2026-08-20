import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRate, type MinuteCount } from "../../shared/throughput";

const SPARK_W = 76;
const SPARK_H = 14;

type ThroughputResponse = {
  per_second: number;
  histogram: MinuteCount[];
};

type Props = {
  onOpenHour: () => void;
};

export function ThroughputMeter({ onOpenHour }: Props) {
  const [perSecond, setPerSecond] = useState<number | null>(null);
  const [bars, setBars] = useState<MinuteCount[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/throughput");
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as ThroughputResponse;
      if (cancelled || !Array.isArray(json.histogram)) {
        return;
      }
      setPerSecond(json.per_second);
      setBars(json.histogram);
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const max = bars.reduce((n, bar) => Math.max(n, bar.n), 0);
  const rate = perSecond === null ? "—" : formatRate(perSecond);
  const title =
    perSecond === null
      ? "Last hour · click to search"
      : `${formatRate(perSecond)} events/s · last hour`;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground"
          aria-label={`${title}. Click to search.`}
          onClick={onOpenHour}
        >
          <span className="whitespace-nowrap">
            {rate}
            <span className="opacity-70">/s</span>
          </span>
          <span
            className="flex h-3.5 shrink-0 items-end"
            style={{ width: SPARK_W }}
            aria-hidden
          >
            {bars.map((bar) => {
              const h =
                max > 0 && bar.n > 0
                  ? Math.max(2, (bar.n / max) * SPARK_H)
                  : 0;
              return (
                <span
                  key={bar.t}
                  className="min-w-0 flex-1 rounded-[1px] bg-sky-500 opacity-80"
                  style={{ height: `${h}px` }}
                />
              );
            })}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        className="bg-popover text-popover-foreground border px-2 py-1.5 font-mono text-[11px] tabular-nums"
      >
        <p>{title}</p>
        <p className="font-sans text-muted-foreground">Click to search</p>
      </TooltipContent>
    </Tooltip>
  );
}
