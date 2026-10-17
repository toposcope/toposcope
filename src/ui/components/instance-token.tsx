import { cn } from "@/lib/utils";

/** An instance by name (#136); "here" is the only plate-outlined token, a key's unknown side is dashed. */
export function InstanceToken({ name, here, dashed }: { name: string; here?: boolean; dashed?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1.5 rounded-[4.4px] border px-2 py-0.5 font-mono text-[12.5px] whitespace-nowrap",
        here ? "border-white/45" : dashed ? "border-dashed border-white/25 text-muted-foreground" : "border-white/15",
      )}
    >
      {name}
      {here ? <span className="font-sans text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">HERE</span> : null}
    </span>
  );
}
