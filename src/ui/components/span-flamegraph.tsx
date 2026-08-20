import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ProfileResponse } from "../../shared/profile";
import { PROFILE_STACK_CAP } from "../../shared/profile";
import {
  flamePinLit,
  formatProfileShare,
  formatProfileValue,
  layoutFlame,
  packageColor,
} from "../flame";

type Props = {
  service: string;
  name: string;
  spanId: string;
  ts: string;
  result: ProfileResponse | null;
  loading: boolean;
  failed: boolean;
  canBackToTrace: boolean;
  onBack: () => void;
};

export function SpanFlamegraph({
  service,
  name,
  spanId,
  ts,
  result,
  loading,
  failed,
  canBackToTrace,
  onBack,
}: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    i: number;
    top: number;
    left: number;
  } | null>(null);
  const stacks = result?.stacks ?? [];
  const layout = useMemo(() => layoutFlame(stacks), [stacks]);
  const pin = selected !== null ? (layout.frames[selected] ?? null) : null;
  const hoverFrame = hover ? (layout.frames[hover.i] ?? null) : null;
  const empty = !loading && !failed && stacks.length === 0;
  const capped =
    (result?.total_samples ?? 0) > stacks.length && stacks.length > 0;
  const multi = (result?.total_profiles ?? 0) > 1;
  const unit = result?.sample_unit || "nanoseconds";
  const typeLabel = `${result?.sample_type || "cpu"} · ${unit}`;
  const clock = (result?.ts || ts || "").slice(11, 23);
  const emptyClock = (result?.ts || ts || "").slice(11, 19);
  const windowLabel =
    result && result.duration_ms > 0
      ? `${Math.round(result.duration_ms / 1000)}s window`
      : "";
  const depths = layout.frames.reduce((max, frame) => Math.max(max, frame.depth), 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    frac,
    label: formatProfileValue(layout.total * frac, unit),
  }));

  return (
    <div
      data-screen-label="Span flamegraph"
      className="flex min-h-0 flex-1 flex-col px-3 pb-3"
    >
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 rounded-t-[6.4px] border border-b-0 border-white/10 bg-card px-2.5">
        <span className="truncate text-[13px] font-medium">
          {service} · {name}
        </span>
        {!empty && !failed && !loading && layout.total > 0 ? (
          <span className="font-mono text-xs whitespace-nowrap">
            {formatProfileValue(layout.total, unit)}
          </span>
        ) : null}
        <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
          {loading ? "Loading…" : failed ? "failed" : typeLabel}
        </span>
        {capped ? (
          <span className="whitespace-nowrap text-[11.5px] text-amber-300">
            {stacks.length} of {result?.total_samples} stacks
          </span>
        ) : null}
        <div className="min-w-2 flex-1" />
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          span_id:{spanId}
        </span>
      </div>

      {capped ? (
        <div className="flex items-center gap-2 border border-b-0 border-white/10 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          Over the {PROFILE_STACK_CAP}-stack cap — showing the heaviest stacks.
        </div>
      ) : null}

      {empty || failed ? (
        <>
          {empty ? (
            <div className="flex shrink-0 items-center gap-2 border border-b-0 border-white/10 bg-background/45 px-2.5 py-[5px] text-[11px] text-muted-foreground/80">
              looked up by span_id · {emptyClock || "—"} UTC
            </div>
          ) : null}
          <div className="flex flex-col items-center gap-1 rounded-b-[6.4px] border border-white/10 bg-card px-5 py-14">
            <span className="text-[13px]">
              {failed ? "Could not load this profile" : "No profile samples for this span"}
            </span>
            <span className="max-w-[440px] text-center text-xs leading-relaxed text-pretty text-muted-foreground">
              {failed
                ? "The request failed."
                : "No samples linked to this span yet — they may not have been attached, exported, or arrived."}
            </span>
            <button
              type="button"
              className="mt-2 h-7 rounded-[4.4px] border border-white/15 px-3 text-[12.5px] hover:bg-accent"
              onClick={onBack}
            >
              {canBackToTrace ? "Back to the waterfall" : "Back to results"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            className="flex shrink-0 items-center gap-2 border border-b-0 border-white/10 bg-background/45 px-2.5 py-[5px] text-[11px] text-muted-foreground/80"
            title={
              multi
                ? `${result?.total_profiles} profiles overlap this span. We render the most recent one and do not merge samples.`
                : undefined
            }
          >
            {loading
              ? "Loading profile…"
              : `samples linked to this span · ${layout.frames.length} frames · profile ${clock || "—"} UTC${windowLabel ? ` · ${windowLabel}` : ""}${multi ? ` · latest of ${result?.total_profiles} profiles` : ""}`}
          </div>
          <div className="relative h-[26px] shrink-0 border border-b-0 border-white/10 bg-background/45">
            <span className="absolute inset-y-0 right-2.5 left-2.5">
              {ticks.map((tick) => (
                <span
                  key={tick.frac}
                  className="absolute top-[7px] font-mono text-[10px] text-muted-foreground"
                  style={{
                    left: `${tick.frac * 100}%`,
                    transform:
                      tick.frac === 0
                        ? "none"
                        : tick.frac === 1
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {tick.label}
                </span>
              ))}
            </span>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto border border-white/10 bg-card",
              pin ? "border-b-0" : "rounded-b-[6.4px]",
            )}
          >
            <div
              className="relative mx-2.5 mt-2 mb-2.5"
              style={{ height: `${(depths + 1) * 22}px` }}
            >
              {layout.frames.map((frame, i) => {
                const width = layout.total > 0 ? (frame.value / layout.total) * 100 : 0;
                const on = selected === i;
                const back = !!pin && !flamePinLit(frame, pin);
                const color = packageColor(frame.pkg);
                return (
                  <div
                    key={`${frame.depth}:${frame.x0}:${frame.name}`}
                    className="absolute box-border flex h-[21px] items-center overflow-hidden rounded-[2.4px] px-1.5 font-mono text-[10.5px] whitespace-nowrap"
                    style={{
                      left: `${layout.total > 0 ? (frame.x0 / layout.total) * 100 : 0}%`,
                      width: `${Math.max(0.35, width)}%`,
                      top: `${frame.depth * 22}px`,
                      background: `${color}${back ? "2b" : on ? "ff" : "cc"}`,
                      boxShadow: on ? "inset 0 0 0 1px oklch(0.985 0 0 / 80%)" : undefined,
                      color: back
                        ? "oklch(0.985 0 0 / 45%)"
                        : "oklch(0.141 0.005 285.823)",
                      cursor: "pointer",
                    }}
                    onClick={() => setSelected((prev) => (prev === i ? null : i))}
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setHover({
                        i,
                        top: r.bottom + 4,
                        left: Math.min(r.left, window.innerWidth - 260),
                      });
                    }}
                    onMouseLeave={() =>
                      setHover((prev) => (prev?.i === i ? null : prev))
                    }
                  >
                    {width >= 3.2 ? frame.name : ""}
                  </div>
                );
              })}
            </div>
          </div>
          {hover && hoverFrame ? (
            <div
              className="pointer-events-none fixed z-50 w-[244px] rounded-[6.4px] border border-white/14 bg-[#18181b] px-2.5 py-2 shadow-[0_12px_28px_oklch(0_0_0_/_55%)]"
              style={{ top: hover.top, left: hover.left }}
            >
              <div className="truncate font-mono text-[11.5px]">{hoverFrame.name}</div>
              <div className="mt-0.5 mb-1.5 font-mono text-[10.5px] text-muted-foreground">
                {hoverFrame.pkg}
              </div>
              {[
                ["total", formatProfileValue(hoverFrame.value, unit)],
                ["self", formatProfileValue(hoverFrame.self, unit)],
                ["share", formatProfileShare(hoverFrame.value, layout.total)],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex h-4 items-center justify-between gap-3 font-mono text-[11px]"
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          ) : null}
          {pin ? (
            <div className="flex shrink-0 items-center gap-3.5 rounded-b-[6.4px] border border-t-0 border-white/10 bg-background/55 px-2.5 py-2">
              <div className="min-w-0 shrink">
                <div className="truncate font-mono text-xs">{pin.name}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {pin.pkg} · {formatProfileValue(pin.self, unit)} self ·{" "}
                  {formatProfileValue(pin.value, unit)} total ·{" "}
                  {formatProfileShare(pin.value, layout.total)} of this profile
                </div>
              </div>
              <div className="min-w-0 flex-1" />
              <button
                type="button"
                className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[4.4px] text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Clear pinned frame"
                aria-label="Clear pinned frame"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
