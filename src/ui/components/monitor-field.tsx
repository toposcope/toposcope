import { cn } from "@/lib/utils";

/** A row of the monitor editor (18j): its label in a 96px column, what it sets beside it. */
export function MonitorField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3", className)}>
      <label htmlFor={htmlFor} className="pt-1.5 text-[12px] text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** 18j's switch: segments on a dark well, the picked one lifted. */
export function MonitorSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-max shrink-0 rounded-[7px] border border-white/10 bg-[#0f0f11] p-[2px]"
    >
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "h-[26px] rounded-[5px] px-2.5 text-[12px]",
            value === id ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

/** 18j's box: a 30px field with a hairline border. */
export const monitorBox =
  "flex min-h-[30px] items-center gap-2 rounded-[6px] border border-white/15 px-2.5 py-[5px] text-[13px]";
