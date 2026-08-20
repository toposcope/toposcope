import { useState } from "react";
import { faultCol, type QueryFault } from "../../query/compile";

type Props = {
  faults: QueryFault[];
};

export function QueryErrorChip({ faults }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex h-[75%] shrink-0 cursor-default items-center gap-1.5 rounded-full border border-red-500/45 bg-red-500/12 px-1.5 py-0.5 pl-2 text-xs text-red-300"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="size-1.5 rounded-full bg-red-500" />
      Query error
      <button
        type="button"
        aria-label="Error detail"
        className="flex h-full w-4 items-center justify-center rounded-full text-[10px] font-semibold text-red-300 hover:bg-red-500/22 hover:text-foreground"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open ? (
        <span className="absolute top-7 right-[-6px] z-40 flex w-72 flex-col gap-0.5 rounded-lg border border-white/14 bg-card px-2.5 py-2 text-left text-xs text-muted-foreground shadow-xl">
          {faults.map((fault) => (
            <span key={`${fault.at}:${fault.msg}`} className="flex gap-1.5">
              <span className="shrink-0 font-mono text-red-300">
                {faultCol(fault.at)}
              </span>
              <span>{fault.msg}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
