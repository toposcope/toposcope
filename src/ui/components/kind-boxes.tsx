import { cn } from "@/lib/utils";
import { kindTitle, kindsWithScope, linkKinds, type KindSends, type LinkKind } from "../link-kinds";

/** A not-sent reason with its field in mono (33a). */
export function NotSentWords({ line }: { line: Extract<KindSends, { sends: false }> }) {
  const at = line.field ? line.reason.indexOf(line.field) : -1;
  if (!line.field || at < 0) {
    return <>not sent: {line.reason}</>;
  }
  return (
    <>
      not sent: {line.reason.slice(0, at)}
      <span className="font-mono">{line.field}</span>
      {line.reason.slice(at + line.field.length)}
    </>
  );
}

/**
 * The six kind boxes (#329, 33a): real checkboxes, all ticked by default. A kind the scope cannot
 * decide stays as it is ticked but cannot be changed, and says why it is not sent. `allowed` limits
 * which kinds may be ticked at all: a link already made may only drop kinds.
 */
export function KindBoxes({
  q,
  ticked,
  onChange,
  legend,
  allowed,
}: {
  q: string;
  ticked: readonly LinkKind[];
  onChange: (kinds: LinkKind[]) => void;
  legend: string;
  allowed?: readonly LinkKind[];
}) {
  const lines = kindsWithScope(q);
  const going = lines.filter((l) => l.sends && ticked.includes(l.kind)).length;
  return (
    <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0 sm:grid-cols-3">
      <legend className="col-span-full pb-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {legend} · {going} of {linkKinds.length}
        {q.trim() ? " with this scope" : ""}
      </legend>
      {lines.map((l) => {
        const may = !allowed || allowed.includes(l.kind);
        const on = ticked.includes(l.kind) && may;
        const off = !l.sends || !may;
        return (
          <label
            key={l.kind}
            className={cn(
              "grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 rounded-[8px] border border-white/10 px-3 py-2.5",
              off ? "border-dashed bg-[#101012]" : "bg-[#0d0d0f]",
            )}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={!l.sends || !may}
              onChange={(e) => onChange(linkKinds.filter((k) => (k === l.kind ? e.target.checked : ticked.includes(k))))}
              className="mt-0.5 size-[15px] accent-[#e7e1d3]"
            />
            <span className={cn("text-[13px] font-medium", off ? "text-zinc-400" : "text-foreground")}>{kindTitle[l.kind]}</span>
            {!may ? (
              <span className="col-start-2 text-[11.5px] leading-[1.4] text-muted-foreground">never sent on this link · make a new key to send it</span>
            ) : l.sends ? (
              <span className="col-start-2 text-[11.5px] leading-[1.4] text-muted-foreground">{on ? l.words : "unticked · not sent"}</span>
            ) : (
              <span className="col-start-2 text-[11.5px] leading-[1.4] text-amber-400">
                <NotSentWords line={l} />
              </span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Kinds as small chips (33c): one per kind, dashed for one that does not go and why. */
export function KindChips({ q, kinds, className }: { q: string; kinds: readonly LinkKind[]; className?: string }) {
  const lines = kindsWithScope(q);
  return (
    <span className={cn("flex min-w-0 max-w-full flex-wrap gap-1", className)}>
      {lines.map((l) => {
        const ticked = kinds.includes(l.kind);
        const words = !ticked
          ? `${l.kind} unticked`
          : l.sends
            ? l.kind
            : l.kind === "profiles"
              ? "profiles · no spans go"
              : `${l.kind} · scope names ${l.cause === "words in the message" ? "words" : l.cause}`;
        const no = !ticked || !l.sends;
        return (
          <span
            key={l.kind}
            title={words}
            className={cn(
              // Capped at its column: a long reason ends in an ellipsis, whole on hover.
              "inline-block h-5 max-w-full truncate rounded-[5px] border px-1.5 font-mono text-[11px] leading-[18px]",
              no ? "border-dashed border-white/10 text-muted-foreground" : "border-white/15 text-zinc-300",
            )}
          >
            {words}
          </span>
        );
      })}
    </span>
  );
}
