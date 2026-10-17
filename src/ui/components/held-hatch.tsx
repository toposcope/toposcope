import type { HeldGap } from "../../shared/held";

const HATCH = "repeating-linear-gradient(135deg, rgba(255,255,255,0.11) 0 1px, transparent 1px 7px)";

/**
 * The spans of the plot a short source's rows are not here for (#139, 5c–5e, 5g, 5h): hatched and
 * labelled, so absent bars never read as zero. A behind or quiet span opens on a dashed edge and
 * runs to now; a hole is closed at both ends, solid.
 */
export function HeldHatch({
  spans,
  fromMs,
  plotSpanMs,
}: {
  spans: Array<HeldGap & { label: string }>;
  fromMs: number;
  plotSpanMs: number;
}) {
  return (
    <>
      {spans.map((span) => {
        const lo = Math.max(0, Math.min(1, (span.from - fromMs) / plotSpanMs));
        const hi = Math.max(0, Math.min(1, (span.to - fromMs) / plotSpanMs));
        if (hi <= lo) {
          return null;
        }
        const hole = span.kind === "hole";
        // A narrow span keeps its label inside the plot, ending at its right edge.
        const narrow = hi - lo < 0.3;
        return (
          <div
            key={`${span.source}:${span.kind}`}
            className={`pointer-events-none absolute inset-y-1 z-[1] ${
              hole ? "border-x border-white/45" : "border-l border-dashed border-white/50"
            }`}
            style={{
              left: `${(lo * 100).toFixed(3)}%`,
              width: `${((hi - lo) * 100).toFixed(3)}%`,
              backgroundImage: HATCH,
              backgroundColor: "rgba(9,9,11,0.45)",
            }}
          >
            <span
              className={`absolute top-0.5 font-mono text-[10.5px] whitespace-nowrap text-muted-foreground ${
                narrow ? "right-1" : "left-1.5"
              }`}
            >
              {span.label}
            </span>
          </div>
        );
      })}
    </>
  );
}
