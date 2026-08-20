import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  UTC_DAY_MS,
  UTC_MONTHS,
  applyAbsClock,
  applyAbsDay,
  shiftUtcMonth,
  utcDayStart,
  utcMonthStart,
  type AbsField,
} from "../absolute-range";
import { absStampUtc } from "../time-range";

type Phase = "date" | "time";

type Props = {
  fromMs: number;
  toMs: number;
  live: boolean;
  onDraft: (fromMs: number, toMs: number) => void;
  onDone: () => void;
};

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

function p2(n: number): string {
  return String(n).padStart(2, "0");
}

function p3(n: number): string {
  return String(n).padStart(3, "0");
}

export function AbsoluteRangeCalendar({
  fromMs,
  toMs,
  live,
  onDraft,
  onDone,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<AbsField>("from");
  const [phase, setPhase] = useState<Phase>("date");
  const [monthMs, setMonthMs] = useState<number | null>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const [msTxt, setMsTxt] = useState<string | null>(null);
  const scrolled = useRef(false);

  const actMs = pick === "to" ? toMs : fromMs;
  const act = new Date(actMs);
  const shownMonth = monthMs ?? utcMonthStart(actMs);
  const monthDate = new Date(shownMonth);
  const monthYear = monthDate.getUTCFullYear();
  const monthIndex = monthDate.getUTCMonth();
  const gridFrom = shownMonth - monthDate.getUTCDay() * UTC_DAY_MS;
  const today = utcDayStart(Date.now());
  const fromDay = utcDayStart(fromMs);
  const toDay = utcDayStart(toMs);
  const bandFrom =
    pick === "from" && hoverDay != null && hoverDay < toDay ? hoverDay : fromDay;
  const bandTo =
    pick === "to" && hoverDay != null && hoverDay > fromDay ? hoverDay : toDay;
  const curH = act.getUTCHours();
  const curM = act.getUTCMinutes();
  const curS = act.getUTCSeconds();
  const curMs = act.getUTCMilliseconds();
  const msField = msTxt ?? p3(curMs);
  const msOk = /^\d{1,3}$/.test(msField.trim());

  useEffect(() => {
    if (scrolled.current || !panelRef.current) {
      return;
    }
    scrolled.current = true;
    panelRef.current.scrollIntoView({ block: "nearest" });
  }, []);

  function commitClock(h: number, m: number, s: number, millis: number) {
    const next = applyAbsClock(pick, fromMs, toMs, h, m, s, millis);
    if (next) {
      onDraft(next.fromMs, next.toMs);
    }
  }

  return (
    <div
      ref={panelRef}
      className="mt-px flex flex-col gap-[7px] rounded-[6.4px] border border-white/12 bg-background/70 p-2"
    >
      <div className="flex flex-col gap-[7px]">
        {(
          [
            ["from", "From", fromMs],
            ["to", "To", toMs],
          ] as const
        ).map(([id, label, val]) => {
          const on = pick === id;
          return (
            <button
              key={id}
              type="button"
              title={`${label} — click to edit this end`}
              className={cn(
                "flex h-[27px] w-full items-center gap-2 rounded-md border px-2 text-left",
                on
                  ? "border-ring bg-secondary"
                  : "border-white/10 bg-transparent",
              )}
              onClick={() => {
                setPick(id);
                setPhase("date");
                setMonthMs(null);
                setHoverDay(null);
                setMsTxt(null);
              }}
            >
              <span
                className={cn(
                  "w-7 shrink-0 text-[11px]",
                  on ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {absStampUtc(val)}
              </span>
              {id === "to" && live && !on ? (
                <span className="shrink-0 text-[10px] tracking-[0.04em] text-muted-foreground uppercase">
                  live
                </span>
              ) : on ? (
                <span className="shrink-0 text-[9.5px] tracking-[0.06em] text-muted-foreground uppercase">
                  {phase === "time" ? "time" : "day"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {phase === "date" ? (
        <>
          <div className="mt-px flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous month"
              className="flex size-[22px] items-center justify-center rounded-[3.4px] border border-white/12 text-[13px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setMonthMs(shiftUtcMonth(shownMonth, -1))}
            >
              ‹
            </button>
            <span className="flex-1 text-center text-[11.5px] font-medium">
              {UTC_MONTHS[monthIndex]} {monthYear}
            </span>
            <button
              type="button"
              aria-label="Next month"
              className="flex size-[22px] items-center justify-center rounded-[3.4px] border border-white/12 text-[13px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setMonthMs(shiftUtcMonth(shownMonth, 1))}
            >
              ›
            </button>
          </div>
          <div
            className="grid grid-cols-7 gap-x-0 gap-y-0.5"
            onMouseLeave={() => setHoverDay(null)}
          >
            {WEEKDAYS.map((w, i) => (
              <span
                key={`${w}-${i}`}
                className="flex h-[18px] items-center justify-center font-mono text-[10px] text-muted-foreground/70"
              >
                {w}
              </span>
            ))}
            {Array.from({ length: 42 }, (_, i) => {
              const ms = gridFrom + i * UTC_DAY_MS;
              const d = new Date(ms);
              const inMonth = d.getUTCMonth() === monthIndex;
              const isFrom = ms === bandFrom;
              const isTo = ms === bandTo;
              const end = isFrom || isTo;
              const inBand = ms > bandFrom && ms < bandTo;
              const ahead = ms > today;
              return (
                <button
                  key={ms}
                  type="button"
                  title={`${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${ahead ? " — after the clock" : ""}`}
                  className={cn(
                    "relative flex h-[25px] items-center justify-center border-none font-mono text-[11px]",
                    isFrom && isTo
                      ? "rounded-[3.4px]"
                      : isFrom
                        ? "rounded-l-[3.4px]"
                        : isTo
                          ? "rounded-r-[3.4px]"
                          : "rounded-none",
                    end
                      ? "bg-primary text-primary-foreground"
                      : inBand
                        ? "bg-white/10 text-foreground"
                        : !inMonth || ahead
                          ? "bg-transparent text-muted-foreground/45"
                          : "bg-transparent text-foreground",
                  )}
                  onMouseEnter={() => setHoverDay(ms)}
                  onClick={() => {
                    const next = applyAbsDay(pick, ms, fromMs, toMs);
                    if (!next) {
                      return;
                    }
                    onDraft(next.fromMs, next.toMs);
                    setPick(next.pick);
                    setPhase("time");
                    setHoverDay(null);
                    setMsTxt(null);
                  }}
                >
                  {d.getUTCDate()}
                  {ms === today && !end ? (
                    <span className="absolute bottom-[3px] left-1/2 size-[3px] -translate-x-1/2 rounded-full bg-[#0ea5e9]" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="mt-px flex items-center gap-1.5">
            <button
              type="button"
              title="Back to the calendar"
              className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-full border border-white/12 px-2 font-mono text-[10.5px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                setPhase("date");
                setHoverDay(null);
              }}
            >
              ‹ {absStampUtc(actMs).slice(0, 10)}
            </button>
            <div className="min-w-1 flex-1" />
            <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
              {pick === "to" ? "End" : "Start"} time · UTC
            </span>
          </div>
          <div className="flex items-end gap-[5px]">
            {(
              [
                ["h", 24, curH],
                ["m", 60, curM],
                ["s", 60, curS],
              ] as const
            ).map(([part, n, cur]) => (
              <div
                key={part}
                className="flex h-[132px] min-w-0 flex-1 flex-col gap-[3px]"
              >
                <span className="block text-center font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground/75">
                  {part === "h" ? "HH" : part === "m" ? "mm" : "ss"}
                </span>
                <TimeColumn
                  count={n}
                  current={cur}
                  scrollKey={`${pick}|${part}`}
                  onPick={(i) =>
                    commitClock(
                      part === "h" ? i : curH,
                      part === "m" ? i : curM,
                      part === "s" ? i : curS,
                      curMs,
                    )
                  }
                />
              </div>
            ))}
            <div className="flex min-w-0 shrink-0 basis-[52px] flex-col gap-[3px]">
              <span className="block text-center font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground/75">
                .mmm
              </span>
              <input
                value={msField}
                size={3}
                spellCheck={false}
                inputMode="numeric"
                aria-label="Milliseconds"
                className={cn(
                  "h-[22px] w-full min-w-0 rounded-[3.4px] border bg-background px-[5px] text-center font-mono text-[11px] outline-none",
                  msOk ? "border-white/15" : "border-destructive/65",
                )}
                onChange={(event) => {
                  const v = event.target.value.replace(/[^0-9]/g, "").slice(0, 3);
                  if (!v.length) {
                    setMsTxt("");
                    return;
                  }
                  setMsTxt(v);
                  commitClock(curH, curM, curS, Number(v));
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-1">
            {(
              [
                ["00:00", 0, 0, 0],
                ["12:00", 12, 0, 0],
                ["23:59:59", 23, 59, 59],
              ] as const
            ).map(([label, h, m, s]) => (
              <button
                key={label}
                type="button"
                className="h-[22px] flex-1 rounded-full border border-white/12 px-1.5 font-mono text-[10.5px] text-muted-foreground hover:border-white/25 hover:text-foreground"
                onClick={() => commitClock(h, m, s, curMs)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="h-[22px] flex-1 rounded-full border border-white/12 px-1.5 font-mono text-[10.5px] text-muted-foreground hover:border-white/25 hover:text-foreground"
              onClick={() => {
                const n = new Date();
                setMsTxt("000");
                commitClock(
                  n.getUTCHours(),
                  n.getUTCMinutes(),
                  n.getUTCSeconds(),
                  0,
                );
              }}
            >
              now
            </button>
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-muted-foreground/80">
          {phase === "time"
            ? `${pick === "to" ? "End" : "Start"} time · click hour, minute, second — ms typed`
            : pick === "to"
              ? "Click a day to set the end · then its time"
              : "Click a day to set the start · then its time"}
        </span>
        <button
          type="button"
          className="h-6 shrink-0 rounded-md bg-white/12 px-2.5 text-[11.5px] hover:bg-white/20"
          onClick={() => {
            if (pick === "from") {
              setPick("to");
              setPhase("date");
              setMonthMs(null);
              setHoverDay(null);
              setMsTxt(null);
              return;
            }
            onDone();
          }}
        >
          {pick === "from" ? "Next: end →" : "Done"}
        </button>
      </div>
    </div>
  );
}

function TimeColumn({
  count,
  current,
  scrollKey,
  onPick,
}: {
  count: number;
  current: number;
  scrollKey: string;
  onPick: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef("");
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (seen.current === scrollKey) {
      return;
    }
    seen.current = scrollKey;
    const id = window.setTimeout(() => {
      el.scrollTop = Math.max(0, current * 21 - 44);
    }, 0);
    return () => window.clearTimeout(id);
  }, [scrollKey, current]);

  return (
    <div
      ref={ref}
      className="flex min-h-0 w-full flex-1 flex-col gap-px overflow-y-auto rounded-md border border-white/10 bg-background p-0.5"
    >
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          className={cn(
            "h-5 w-full shrink-0 rounded-[2.4px] font-mono text-[11px]",
            i === current
              ? "bg-primary text-primary-foreground"
              : "bg-transparent text-foreground hover:bg-accent",
          )}
          onClick={() => onPick(i)}
        >
          {p2(i)}
        </button>
      ))}
    </div>
  );
}
