import { CountText } from "@/components/count-text";
import { stepIndex } from "@/keyboard";
import { levelFill } from "@/level";
import type { FacetValue, LogLevel } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { KeyboardEvent } from "react";

type Props = {
  field: string;
  values: FacetValue[];
  active: string | string[] | undefined;
  loading: boolean;
  onToggle: (field: string, value: string) => void;
  onOnly: (field: string, value: string) => void;
  onClear: (field: string) => void;
  onRemove?: () => void;
  prefix?: string;
  onPrefixChange?: (value: string) => void;
};

function barClass(field: string, value: string): string {
  if (field !== "level") {
    return "bg-muted-foreground/40";
  }
  return levelFill[value as LogLevel] ?? "bg-muted-foreground/40";
}

function activeList(active: string | string[] | undefined): string[] {
  if (active == null) {
    return [];
  }
  return Array.isArray(active) ? active : [active];
}

export function FacetGroup({
  field,
  values,
  active,
  loading,
  onToggle,
  onOnly,
  onClear,
  onRemove,
  prefix,
  onPrefixChange,
}: Props) {
  const max = Math.max(1, ...values.map((item) => item.n));
  const selected = activeList(active);
  const selLabel =
    selected.length >= 2
      ? `${selected.length} selected · any of`
      : selected.length === 1
        ? "1 selected"
        : "";

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5">
        <h2 className="min-w-0 truncate text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {field}
        </h2>
        {selLabel ? (
          <span className="shrink-0 text-[10.5px] font-normal tracking-normal text-muted-foreground/80 normal-case">
            {selLabel}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {selected.length > 0 ? (
          <button
            type="button"
            className="h-[18px] shrink-0 rounded-[3.4px] px-[5px] text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Clear this facet"
            onClick={() => onClear(field)}
          >
            clear
          </button>
        ) : null}
        {onRemove ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-5 shrink-0"
            title={`Remove ${field} facet`}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      {onPrefixChange ? (
        <Input
          className="mb-1.5 h-7 font-mono text-[11px]"
          placeholder="prefix…"
          value={prefix ?? ""}
          onChange={(e) => onPrefixChange(e.target.value)}
        />
      ) : null}
      {loading && values.length === 0 ? (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 3 }, (_, i) => (
            <span key={i} className="h-3 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : values.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <div
          data-kbd="facet"
          className="flex flex-col gap-px"
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              return;
            }
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
              return;
            }
            const items = [
              ...e.currentTarget.querySelectorAll<HTMLElement>("[data-facet-value]"),
            ];
            const row =
              e.target instanceof HTMLElement
                ? e.target.closest("[data-facet-row]")
                : null;
            const current = row?.querySelector<HTMLElement>("[data-facet-value]");
            const i = current ? items.indexOf(current) : -1;
            if (i < 0) {
              return;
            }
            e.preventDefault();
            items[stepIndex(i, e.key === "ArrowDown" ? 1 : -1, items.length)]?.focus();
          }}
        >
          {values.map((item) => {
            const on = selected.some(
              (value) => value.toLowerCase() === item.v.toLowerCase(),
            );
            const onlyInert = selected.length === 1 && on;
            return (
              <div key={item.v} data-facet-row="" className="flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  data-facet-value=""
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-accent/60"
                  onClick={() => onToggle(field, item.v)}
                  aria-pressed={on}
                >
                  <span
                    className={`flex size-2.5 shrink-0 items-center justify-center rounded-[2.4px] border text-[8px] leading-none ${
                      on
                        ? "border-foreground bg-foreground text-background"
                        : "border-input"
                    }`}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {item.v}
                  </span>
                  <span className="relative h-[3px] w-[38px] shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                    <span
                      className={`absolute inset-y-0 left-0 ${barClass(field, item.v)}`}
                      style={{ width: `${(item.n / max) * 100}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                    <CountText n={item.n} />
                  </span>
                </button>
                {selected.length >= 1 ? (
                  <button
                    type="button"
                    className={`h-5 shrink-0 rounded-[3.4px] border border-white/12 px-[5px] text-[10.5px] text-muted-foreground/75 hover:border-ring hover:text-foreground ${
                      onlyInert ? "invisible pointer-events-none" : ""
                    }`}
                    title={`Show only ${field}:${item.v}`}
                    disabled={onlyInert}
                    onClick={() => onOnly(field, item.v)}
                  >
                    only
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
