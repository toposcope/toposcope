import { CountText } from "@/components/count-text";
import type { FacetValue } from "@/types";

export type BoardFieldBind = {
  key: string;
  value: string | null;
  values: FacetValue[];
};

type InputsProps = {
  capLabel: string;
  fields: BoardFieldBind[];
  windowLabel: string | null;
  onPick: (key: string, value: string) => void;
  onWindow: () => void;
};

export function BoardInputs({
  capLabel,
  fields,
  windowLabel,
  onPick,
  onWindow,
}: InputsProps) {
  return (
    <div className="shrink-0 border-b px-3 py-2.5">
      <div className="mb-0.5 flex items-center gap-1.5">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="shrink-0 text-muted-foreground"
        >
          <path d="M4 7h9" />
          <path d="M17 7h3" />
          <path d="M4 17h3" />
          <path d="M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
        <span className="shrink-0 text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Board inputs
        </span>
        <span className="min-w-1 flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground/60">{capLabel}</span>
      </div>
      <p className="text-[11.5px] leading-snug text-pretty text-muted-foreground/85">
        The only live controls on this board. Everything else is its template.
      </p>
      <div className="mt-2.5 flex flex-col gap-2.5">
        {fields.map((field) => {
          const set = Boolean(field.value);
          return (
            <div key={field.key}>
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-3.5 w-0.5 shrink-0 rounded-full ${
                    set ? "bg-white/22" : "bg-amber-400"
                  }`}
                />
                <span className="shrink-0 font-mono text-[11.5px]">{field.key}</span>
                <span className="min-w-1 flex-1" />
                <span
                  className={`shrink-0 font-mono text-[11.5px] ${
                    set ? "text-foreground" : "text-amber-400"
                  }`}
                >
                  {field.value ?? "Not set"}
                </span>
              </div>
              <div className="mt-1 flex flex-col gap-px">
                {field.values.map((item) => {
                  const on = field.value === item.v;
                  return (
                    <button
                      key={item.v}
                      type="button"
                      title={
                        on
                          ? `${field.key}:${item.v} — the board's current value`
                          : `Search ${field.key}:${item.v}`
                      }
                      className={`flex h-6 w-full items-center gap-1.5 rounded-[3.4px] px-1.5 text-left ${
                        on ? "bg-accent" : "hover:bg-accent/55"
                      }`}
                      onClick={() => onPick(field.key, item.v)}
                    >
                      <span
                        className={`size-[9px] shrink-0 rounded-full border ${
                          on
                            ? "border-foreground bg-foreground"
                            : "border-white/30 bg-transparent"
                        }`}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
                          on ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {item.v}
                      </span>
                      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/75">
                        <CountText n={item.n} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {windowLabel ? (
          <div>
            <div className="flex items-center gap-1.5">
              <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-white/22" />
              <span className="shrink-0 font-mono text-[11.5px]">window</span>
            </div>
            <button
              type="button"
              title="The board window — opens the same clock the rest of the app uses"
              className="mt-1 flex h-[26px] w-full items-center gap-1.5 rounded-md border border-input px-[7px] font-mono text-[11.5px] hover:bg-accent"
              onClick={onWindow}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="shrink-0"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              {windowLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type EmptyProps = {
  keys: string[];
  template: string;
  groups: BoardFieldBind[];
  onPick: (key: string, value: string) => void;
};

export function BoardEmpty({ keys, template, groups, onPick }: EmptyProps) {
  const holes = keys.join(" and ");
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-5 py-10">
      <span className="text-sm">Pick {holes} to run this board</span>
      <span className="max-w-[470px] text-center text-[12.5px] leading-normal text-pretty text-muted-foreground">
        Nothing has been queried yet. The template is {template || "all logs"}; {holes} is
        the case, and the board will not guess it.
      </span>
      <div className="mt-3 flex flex-col gap-2.5">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col items-center gap-1.5">
            <span className="font-mono text-[11.5px] text-amber-400">{group.key}</span>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {group.values.map((item) => (
                <button
                  key={item.v}
                  type="button"
                  className="h-7 rounded-md border border-input px-[11px] font-mono text-xs hover:border-ring hover:bg-accent"
                  onClick={() => onPick(group.key, item.v)}
                >
                  {item.v}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
