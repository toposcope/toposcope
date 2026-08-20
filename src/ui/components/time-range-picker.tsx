import { forwardRef, useState } from "react";
import { Calendar, ChevronDown, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  formatRangeToken,
  parseRangeMs,
  rangePresets,
  rangeUnits,
  rangeUnitTitles,
  stepRangeCount,
  type RangeUnit,
} from "../../query/relative";
import { absWindowOk, resolveRangeApply } from "../absolute-range";
import { toLocalInput, type RangeMode } from "../search-url";
import {
  absApplyPreview,
  absStampUtc,
  draftPartsForRange,
  isValidRelativeDraft,
  rangeTriggerLabel,
} from "../time-range";
import { AbsoluteRangeCalendar } from "./absolute-range-calendar";

type Props = {
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  liveWindowMs: number;
  hideAbsolute?: boolean;
  lockAbsolute?: boolean;
  disabled?: boolean;
  onRangeChange: (range: RangeMode) => void;
  onCustomRange?: (from: string, to: string) => void;
};

const sectionLabel =
  "px-0.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase";

export const TimeRangePicker = forwardRef<HTMLButtonElement, Props>(
  function TimeRangePicker(
    {
      range,
      from,
      to,
      live,
      liveWindowMs,
      hideAbsolute = false,
      lockAbsolute = false,
      disabled = false,
      onRangeChange,
      onCustomRange,
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [absOpen, setAbsOpen] = useState(false);
    const [absTouched, setAbsTouched] = useState(false);
    const [absDraftFrom, setAbsDraftFrom] = useState<number | null>(null);
    const [absDraftTo, setAbsDraftTo] = useState<number | null>(null);
    const [count, setCount] = useState(1);
    const [unit, setUnit] = useState<RangeUnit>("h");

    const now = Date.now();
    const committedSpan =
      range === "custom"
        ? live
          ? liveWindowMs
          : Date.parse(to) - Date.parse(from)
        : (parseRangeMs(range) ?? 60 * 60 * 1000);
    const committedTo = range === "custom" && !live ? Date.parse(to) : now;
    const committedFrom =
      range === "custom" && !live
        ? Date.parse(from)
        : committedTo -
          (Number.isFinite(committedSpan) ? committedSpan : 60 * 60 * 1000);
    const seedFrom = Number.isNaN(committedFrom) ? now : committedFrom;
    const seedTo = Number.isNaN(committedTo) ? now : committedTo;

    function syncDraft() {
      const parts = draftPartsForRange(range, from, to, live, liveWindowMs);
      setCount(parts.count);
      setUnit(parts.unit);
      setAbsOpen(false);
      setAbsTouched(false);
      setAbsDraftFrom(seedFrom);
      setAbsDraftTo(seedTo);
    }

    const draftToken = formatRangeToken(count, unit);
    const draftValid = isValidRelativeDraft(count, unit);
    const absFromMs = absDraftFrom ?? seedFrom;
    const absToMs = absDraftTo ?? seedTo;
    const absOk = absWindowOk(absFromMs, absToMs);
    const apply = resolveRangeApply(
      absTouched,
      absFromMs,
      absToMs,
      draftToken,
      draftValid,
    );

    function applyQuick(preset: string) {
      onRangeChange(preset);
      setOpen(false);
    }

    function applyDraft() {
      if (!apply) {
        return;
      }
      if (apply.kind === "abs") {
        if (!onCustomRange) {
          return;
        }
        onCustomRange(
          toLocalInput(new Date(apply.fromMs)),
          toLocalInput(new Date(apply.toMs)),
        );
      } else {
        onRangeChange(apply.token);
      }
      setOpen(false);
    }

    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            syncDraft();
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            className="h-8 gap-1.5 px-2.5 font-normal data-[state=open]:border-ring data-[state=open]:bg-secondary"
          >
            <Clock className="size-[13px]" />
            <span className="font-mono text-xs">
              {rangeTriggerLabel(range, from, to)}
            </span>
            <ChevronDown className="size-2.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="max-h-[calc(100vh-132px)] w-[300px] overflow-y-auto p-2"
          align="start"
        >
          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Quick</span>
            <div className="grid grid-cols-5 gap-[3px]">
              {rangePresets.map((preset) => {
                const on = range === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    className={cn(
                      "h-[26px] rounded-sm font-mono text-xs",
                      on
                        ? "border border-ring bg-secondary text-secondary-foreground"
                        : "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    onClick={() => applyQuick(preset)}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="my-2.5 h-px bg-border" />

          <div className="flex flex-col gap-1.5">
            <span className={sectionLabel}>Relative</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Last</span>
              <div className="flex h-7 items-center overflow-hidden rounded-md border border-input">
                <button
                  type="button"
                  className="flex size-[22px] h-[26px] w-[22px] items-center justify-center text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    setCount(stepRangeCount(count, unit, -1));
                  }}
                >
                  −
                </button>
                <span className="min-w-[34px] text-center font-mono text-xs tabular-nums">
                  {count}
                </span>
                <button
                  type="button"
                  className="flex h-[26px] w-[22px] items-center justify-center text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    setCount(stepRangeCount(count, unit, 1));
                  }}
                >
                  +
                </button>
              </div>
              <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-input p-0.5">
                {rangeUnits.map((item) => {
                  const on = unit === item;
                  return (
                    <button
                      key={item}
                      type="button"
                      title={rangeUnitTitles[item]}
                      className={cn(
                        "h-[22px] min-w-0 flex-1 rounded-sm font-mono text-[11px]",
                        on
                          ? "bg-secondary text-secondary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => {
                        setUnit(item);
                      }}
                    >
                      {item}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {hideAbsolute ? null : <div className="my-2.5 h-px bg-border" />}

          {hideAbsolute ? null : (
            <div
              className={cn(
                "flex flex-col gap-1.5",
                lockAbsolute && "pointer-events-none opacity-35",
              )}
              title={
                lockAbsolute
                  ? "A board window is a relative range — Quick or Last N only."
                  : undefined
              }
            >
              <span className={sectionLabel}>Absolute</span>
              {lockAbsolute ? (
                <span className="px-0.5 text-[11px] leading-snug text-muted-foreground/80">
                  A board window is a relative range — Quick or Last N only.
                </span>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  title={
                    absOpen
                      ? "Close the calendar"
                      : "Pick the window on a calendar — one range, UTC, to the millisecond"
                  }
                  className={cn(
                    "flex w-full items-center gap-[9px] rounded-md border px-2 py-1.5 text-left",
                    absOpen
                      ? "border-ring bg-secondary"
                      : "border-input bg-transparent hover:border-ring",
                  )}
                  onClick={() => setAbsOpen((v) => !v)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    {(
                      [
                        ["From", absFromMs, ""],
                        ["To", absToMs, live && !absTouched ? "live" : ""],
                      ] as const
                    ).map(([label, val, affix]) => (
                      <span
                        key={label}
                        className="flex min-w-0 items-center gap-[7px]"
                      >
                        <span className="w-7 shrink-0 text-[11px] text-muted-foreground">
                          {label}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                            absTouched ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {absStampUtc(val)}
                        </span>
                        {affix && !absTouched ? (
                          <span className="shrink-0 text-[10px] tracking-[0.04em] text-muted-foreground uppercase">
                            {affix}
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                  <Calendar className="size-[13px] shrink-0 text-muted-foreground" />
                </button>
                {absOpen ? (
                  <AbsoluteRangeCalendar
                    fromMs={absFromMs}
                    toMs={absToMs}
                    live={live && !absTouched}
                    onDraft={(nextFrom, nextTo) => {
                      setAbsDraftFrom(nextFrom);
                      setAbsDraftTo(nextTo);
                      setAbsTouched(true);
                    }}
                    onDone={() => setAbsOpen(false)}
                  />
                ) : null}
              </div>
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2.5"
              disabled={!apply}
              onClick={applyDraft}
            >
              Apply
            </Button>
            <span
              className={cn(
                "flex-1 text-[11px] leading-snug",
                apply && !(absTouched && !absOk)
                  ? "text-muted-foreground/80"
                  : "text-destructive",
              )}
            >
              {absTouched
                ? absApplyPreview(absFromMs, absToMs)
                : "Windows cap at 365 days."}
            </span>
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
