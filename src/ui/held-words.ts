import type { HeldGap, HeldSource } from "../shared/held";

/**
 * The words Search uses for what this instance holds (#139), from the Held sheet: position told
 * in time, never "healthy", "degraded" or "lagging". UTC, as the rest of the app reads times.
 */

const pad = (n: number) => String(n).padStart(2, "0");

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth() && x.getUTCDate() === y.getUTCDate();
}

function day(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function hm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function hms(ms: number): string {
  return `${hm(ms)}:${pad(new Date(ms).getUTCSeconds())}`;
}

/** `14:56:02` today, `08-13 23:58:02` before. */
export function heldClock(ms: number, now: number): string {
  return sameDay(ms, now) ? hms(ms) : `${day(ms)} ${hms(ms)}`;
}

/** `12:58` today, `08-13 23:58` before: the pill's short form. */
function shortClock(ms: number, now: number): string {
  return sameDay(ms, now) ? hm(ms) : `${day(ms)} ${hm(ms)}`;
}

/** `08-09 18:40`: a hole's ends always carry their day. */
function holeClock(ms: number): string {
  return `${day(ms)} ${hm(ms)}`;
}

/** `4m`, `2h 2m`; in Live `4m 12s`, ticking like Live's own age. */
export function heldLag(ms: number, live = false): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(s / 60);
  if (minutes < 60) {
    if (live && minutes > 0) return `${minutes}m ${s % 60}s`;
    if (live) return `${s}s`;
    return `${Math.max(1, Math.round(ms / 60_000))}m`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 || hours >= 24 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function quietVerb(connects: "we" | "they"): string {
  return connects === "we" ? "not answering" : "has not called";
}

/** The group head beside TOPOSCOPE: `caught up`, `2 short`, `1 hole`. */
export function groupHeadWords(sources: HeldSource[]): string {
  const short = sources.filter((s) => s.state.kind !== "caught-up").length;
  if (short > 0) {
    return `${short} short`;
  }
  const holes = sources.filter((s) => s.hole).length;
  return holes > 0 ? `${holes} ${holes === 1 ? "hole" : "holes"}` : "caught up";
}

/** A source's position lines in the group, only when it is short or has a hole. */
export function positionLines(source: HeldSource, now: number, live = false): string[] {
  const lines: string[] = [];
  const state = source.state;
  if (state.kind === "behind") {
    lines.push(`${heldLag(now - state.readTo, live)} behind · read to ${heldClock(state.readTo, now)}`);
  } else if (state.kind === "quiet") {
    const lag = now - state.since;
    lines.push(`${quietVerb(state.connects)} since ${heldClock(state.since, now)}${lag >= 3_600_000 ? ` · ${heldLag(lag)}` : ""}`);
  }
  if (source.hole) {
    lines.push(`hole ${holeClock(source.hole.from)} → ${holeClock(source.hole.to)}`);
  }
  return lines;
}

/** The pill beside the count, while a source is short inside the window: one line, naming it. */
export function pillWords(gaps: HeldGap[], sources: HeldSource[], now: number, live = false): string | null {
  const names = [...new Set(gaps.map((g) => g.source))];
  if (names.length === 0) {
    return null;
  }
  if (names.length > 1) {
    return `${names.length} short · ${names.join(" · ")}`;
  }
  const name = names[0]!;
  const source = sources.find((s) => s.name === name);
  const open = gaps.find((g) => g.kind !== "hole");
  if (open && source?.state.kind === "behind") {
    return `${name} ${heldLag(now - source.state.readTo, live)} behind`;
  }
  if (open && source?.state.kind === "quiet") {
    return `${name} ${quietVerb(source.state.connects)} since ${shortClock(source.state.since, now)}`;
  }
  const hole = gaps.find((g) => g.kind === "hole")!;
  return `${name} hole ${holeClock(hole.from)} → ${day(hole.to)}`;
}

/**
 * The label over a hatched span on the plot. With one source in the group the name goes without
 * saying; with several short ones each span says only whose it is.
 */
export function hatchLabel(gap: HeldGap, sources: HeldSource[], shortCount: number): string {
  const source = sources.find((s) => s.name === gap.source);
  if (gap.kind === "hole") {
    return sources.length > 1 ? `${gap.source} · hole · gone at source` : "hole · gone at source";
  }
  if (gap.kind === "quiet") {
    const verb = source?.state.kind === "quiet" ? quietVerb(source.state.connects) : "not answering";
    return `no rows from ${gap.source} — ${verb}, not quiet`;
  }
  if (shortCount > 1) {
    return gap.source;
  }
  return sources.length > 1 ? `${gap.source} · not here yet` : "not here yet";
}

/** The hatched table row, at the source's read position. */
export function tableRowWords(gap: HeldGap, sources: HeldSource[], now: number): string {
  const source = sources.find((s) => s.name === gap.source);
  if (gap.kind === "hole") {
    return `${gap.source} hole ${holeClock(gap.from)} → ${holeClock(gap.to)} — gone at source`;
  }
  if (gap.kind === "quiet") {
    const state = source?.state.kind === "quiet" ? source.state : null;
    const since = state ? state.since : gap.from;
    return `${gap.source} ${quietVerb(state?.connects ?? "we")} since ${heldClock(since, now)} — nothing after this is known from it`;
  }
  return `${gap.source} read to ${heldClock(gap.from, now)} — its rows after this are not here yet`;
}

/** Where the hatched row sits: at the read position, or at a hole's far end. */
export function tableRowAt(gap: HeldGap): number {
  return gap.kind === "hole" ? gap.to : gap.from;
}

/** The amber note under a panel whose number is a percentile, a rate or an average. */
export function overWhatIsHereWords(gaps: HeldGap[]): string {
  const names = [...new Set(gaps.map((g) => g.source))];
  return `of what is here · ${names.length === 1 ? `${names[0]} short` : `${names.length} short`}`;
}
