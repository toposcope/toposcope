import { CountText } from "@/components/count-text";
import type { ScopeChip } from "../held-view";

/** The pill beside a floor count (#139): names the short source on one line, while the window overlaps its gap. */
export function HeldPill({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/16 bg-white/5 px-2.5 py-0.5 text-xs whitespace-nowrap text-foreground">
      <span className="size-1.5 rounded-full" style={{ background: "#fbbf24" }} />
      {text}
    </span>
  );
}

/**
 * The grey scope beside the count (#139, 5f, 5o): rows behind it came through a filter the hunt
 * does not already imply. Grey, never amber — nothing the link promised is missing.
 */
export function ScopeChipView({ chip }: { chip: ScopeChip }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-white/12 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
      {chip.count !== null ? (
        <span className="font-mono text-foreground tabular-nums">
          <CountText n={chip.count} />
        </span>
      ) : null}
      within
      {chip.filter ? (
        <>
          <span className="font-mono text-foreground">{chip.filter}</span>
          from {chip.from}
        </>
      ) : (
        <span>{chip.filters} filters</span>
      )}
    </span>
  );
}
