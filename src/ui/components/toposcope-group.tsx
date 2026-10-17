import { useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { CountText } from "@/components/count-text";
import type { HeldSource } from "../../shared/held";
import { groupHeadWords, positionLines } from "../../shared/held-words";

/** Rows the group shows before the caught-up rest collapse into one line (5g). */
export const groupRowsShown = 5;

type Props = {
  sources: HeldSource[];
  /** The hunt's count per source, from the `toposcope` facet. */
  counts: Map<string, number>;
  /** A source's count is a floor over this window. */
  floorFor: (name: string) => boolean;
  /** Sources the bar already names (`toposcope:<name>`). */
  checked: string[];
  now: number;
  live: boolean;
  /** "follow" lists only the sources holding the followed value; "frozen" is inert, like every facet in Surroundings. */
  mode: "search" | "board" | "follow" | "frozen";
  onToggle: (name: string) => void;
  onOpenLinks: () => void;
};

function CopyFilter({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy the filter"
      className="shrink-0 rounded-[3px] p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1_200);
        });
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/**
 * What this instance holds (#139, Held sheet 5b–5i, 5q): each source as named on its side, its
 * count in this hunt, its position only when short, its filter word for word when it has one,
 * and the door to Links. A facet like Level: ticking a source writes `toposcope:<name>`.
 */
export function ToposcopeGroup({ sources, counts, floorFor, checked, now, live, mode, onToggle, onOpenLinks }: Props) {
  const listed = mode === "follow" ? sources.filter((s) => (counts.get(s.name) ?? 0) > 0) : sources;
  const short = listed.filter((s) => s.state.kind !== "caught-up" || s.hole);
  const caught = listed
    .filter((s) => s.state.kind === "caught-up" && !s.hole)
    .sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0));
  const room = Math.max(0, groupRowsShown - short.length);
  const shownCaught = caught.length > room + 1 ? caught.slice(0, room) : caught;
  const rest = caught.slice(shownCaught.length);
  const restCount = rest.reduce((sum, s) => sum + (counts.get(s.name) ?? 0), 0);
  const inert = mode === "frozen";
  const everyFiltered = listed.length > 0 && listed.every((s) => s.filters.length > 0);
  const followShort = mode === "follow" ? listed.find((s) => s.state.kind !== "caught-up") : undefined;

  const row = (source: HeldSource) => {
    const on = checked.some((v) => v.toLowerCase() === source.name.toLowerCase());
    const lines = positionLines(source, now, live);
    const head = (
      <>
        {inert ? null : (
          <span
            className={`flex size-2.5 shrink-0 items-center justify-center rounded-[2.4px] border text-[8px] leading-none ${
              on ? "border-foreground bg-foreground text-background" : "border-input"
            }`}
          >
            {on ? "✓" : ""}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{source.name}</span>
        <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          <CountText n={counts.get(source.name) ?? 0} floor={floorFor(source.name)} />
        </span>
      </>
    );
    return (
      <div key={source.name} className="flex min-w-0 flex-col">
        {inert ? (
          <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5">{head}</div>
        ) : (
          <button
            type="button"
            className={`flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left ${on ? "bg-accent" : "hover:bg-accent/60"}`}
            title={`toposcope:${source.name}`}
            aria-pressed={on}
            onClick={() => onToggle(source.name)}
          >
            {head}
          </button>
        )}
        {lines.map((line) => (
          <span
            key={line}
            className={`flex gap-1 font-mono text-[11px] leading-snug text-muted-foreground ${inert ? "pl-1" : "pl-[18px]"}`}
          >
            <span className="shrink-0 text-amber-400">▲</span>
            <span className="min-w-0">{line}</span>
          </span>
        ))}
        {source.filters.map((filter) => (
          <span
            key={filter}
            className={`flex min-w-0 items-center gap-1 pt-0.5 font-mono text-[11.5px] text-foreground/90 ${inert ? "pl-1" : "pl-[18px]"}`}
          >
            <span className="min-w-0 truncate select-text" title={filter}>
              {filter}
            </span>
            <CopyFilter text={filter} />
          </span>
        ))}
      </div>
    );
  };

  const note =
    mode === "frozen"
      ? "Counts are around the frozen row."
      : mode === "follow"
        ? `Only sources holding this value.${followShort ? ` A hop on ${followShort.name} may be missing.` : ""}`
        : mode === "board"
          ? "Pulled rows, as ordinary rows."
          : everyFiltered
            ? "This instance holds only what these filters let through."
            : "Pulled rows, as ordinary rows. A source with no filter line takes everything.";

  return (
    <div className="border-b p-3">
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <h2 className="text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Toposcope</h2>
        <span className="font-mono text-[11px] text-muted-foreground/85">{groupHeadWords(listed)}</span>
        <span className="min-w-0 flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground/60">
          {mode === "follow" ? `${listed.length} of ${sources.length}` : sources.length}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {short.map(row)}
        {shownCaught.map(row)}
        {rest.length > 0 ? (
          <div className={`flex min-w-0 items-center gap-1.5 py-0.5 ${inert ? "pl-1" : "pl-[18px]"} pr-1`}>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
              + {rest.length} more, all caught up
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              <CountText n={restCount} />
            </span>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-pretty text-muted-foreground/85">{note}</span>
        {inert ? null : (
          <button
            type="button"
            className="flex shrink-0 items-center text-[11.5px] text-foreground/90 hover:text-foreground"
            onClick={onOpenLinks}
          >
            Links
            <ChevronRight className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
