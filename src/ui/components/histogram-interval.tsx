import { cn } from "@/lib/utils";
import type { HistogramChartKind, HistogramIntervalId } from "../../query/histogram";
import {
  autoChipInterval,
  histogramChipIds,
  standingChipInterval,
} from "../histogram-zoom";

type Props = {
  spanMs: number;
  override: HistogramIntervalId | null;
  chart: HistogramChartKind;
  onCommit: (next: HistogramIntervalId | null) => void;
};

function chipClass(on: boolean): string {
  return cn(
    "h-[22px] whitespace-nowrap rounded-sm px-2 font-mono text-[11px]",
    on
      ? "bg-accent text-foreground"
      : "bg-transparent text-muted-foreground hover:text-foreground",
  );
}

export function HistogramIntervalChips({
  spanMs,
  override,
  chart,
  onCommit,
}: Props) {
  const autoId = autoChipInterval(spanMs, chart);
  const autoOn = override === null;
  const wanted = override;
  const active = wanted ? standingChipInterval(spanMs, wanted, chart) : autoId;
  const standingIn = wanted !== null && active !== wanted;
  const ids = histogramChipIds(spanMs, chart);

  return (
    <div className="flex h-[26px] shrink-0 items-center rounded-md border border-input p-0.5">
      <button
        type="button"
        title={`Bar width picked for the window (${autoId})`}
        className={chipClass(autoOn)}
        onClick={() => onCommit(null)}
      >
        {autoOn ? `Auto · ${autoId}` : "Auto"}
      </button>
      {ids.map((id) => {
        const on = !autoOn && id === active;
        const standIn = standingIn && id === active;
        return (
          <button
            key={id}
            type="button"
            title={
              standIn
                ? `Standing in for ${wanted} — too few bars at this zoom; ${wanted} returns when you zoom back out`
                : `Bar width ${id}`
            }
            className={chipClass(on)}
            onClick={() => onCommit(id)}
          >
            {standIn ? `${id}*` : id}
          </button>
        );
      })}
    </div>
  );
}
