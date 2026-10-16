import { cn } from "@/lib/utils";
import {
  followChangedWords,
  followOpenedWords,
  type FollowOpened,
} from "../../shared/follow-span";

/** Says which window the Follow tab opened on; dashed with Reset once the clock moves. */
export function FollowOpenedChip({
  opened,
  moved,
  onReset,
}: {
  opened: FollowOpened;
  moved: boolean;
  onReset: () => void;
}) {
  const shortfall = opened.how === "refused" || opened.how === "failed";
  return (
    <>
      <span
        data-testid="follow-opened"
        className={cn(
          "inline-flex items-center rounded-md border px-2 py-0.5 text-xs whitespace-nowrap",
          moved
            ? "border-dashed border-white/25 text-muted-foreground"
            : shortfall
              ? "border-amber-400/60 text-amber-300"
              : "border-white/25 text-foreground/90",
        )}
      >
        {moved ? followChangedWords(opened) : followOpenedWords(opened.how)}
      </span>
      {moved ? (
        <button
          type="button"
          className="inline-flex h-6 items-center rounded-md bg-white/10 px-2 text-[12px] text-foreground hover:bg-white/15"
          onClick={onReset}
        >
          Reset
        </button>
      ) : null}
    </>
  );
}
