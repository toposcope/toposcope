import { gapsIn, type HeldGap, type HeldSource, type Window } from "../shared/held";
import { heldClock, holeClock } from "../shared/held-words";
import type { Span } from "../shared/span";

/**
 * What a trace and a profile say about where their rows entered (#330, #332, frames 33d, 33f),
 * from what this instance holds (#139): the sources' read positions, told against the trace's
 * own time. A trace with spans missing never reads as complete.
 */

/** A part of the amber line: names and times are set in mono. */
export type HeldPart = { text: string; mono?: boolean };

export type TraceChip = {
  name: string;
  spans: number;
  /** `here` for this instance's own; `pulled` for a source this instance has no link to (a relay's). */
  state: "here" | "caught-up" | "short" | "pulled";
  words: string;
};

export type TraceHatch = {
  key: string;
  source: string;
  kind: HeldGap["kind"];
  /** The span of the trace's time its spans are not here for, as fractions of the trace. */
  lo: number;
  hi: number;
  label: string;
  tag: string;
};

export type TraceHeld = {
  /** Whether to draw where spans entered at all: nothing changes on an instance that is not linked. */
  linked: boolean;
  /** How many instances the spans here entered at. */
  instances: number;
  chips: TraceChip[];
  /** One amber line while a source is short inside the trace; null when none is. */
  line: HeldPart[] | null;
  /** The source the line's link goes to, when it names one. */
  lineSource: string | null;
  hatches: TraceHatch[];
  short: boolean;
};

const pad3 = (n: number) => String(n).padStart(3, "0");

/** `13:23:19.910`: a trace is read in milliseconds, so its read position is too. */
export function traceClock(ms: number, now: number): string {
  return `${heldClock(ms, now)}.${pad3(((ms % 1000) + 1000) % 1000)}`;
}

/** The instance a span or a profile entered at: its `toposcope`, or this instance for its own. */
export function enteredName(row: { toposcope?: string; pulled_at?: string | null }, here: string): string {
  return row.toposcope || here || "this instance";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function traceHeld(input: {
  spans: Span[];
  sources: HeldSource[];
  now: number;
  here: string;
  /** The trace's start and length as the waterfall draws it. */
  baseMs: number;
  totalMs: number;
  /** The time the trace was opened from (the log's), for a trace with no spans here. */
  at?: number;
}): TraceHeld {
  const { spans, sources, now, here, baseMs, totalMs } = input;
  const pulled = spans.some((s) => Boolean(s.pulled_at));
  const linked = sources.length > 0 || pulled;
  const counts = new Map<string, number>();
  const own = new Set<string>();
  for (const span of spans) {
    const name = enteredName(span, here);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!span.pulled_at) {
      own.add(name);
    }
  }
  let window: Window | null = null;
  if (spans.length > 0 && Number.isFinite(baseMs)) {
    window = { from: baseMs, to: baseMs + Math.max(0, totalMs) };
  } else if (input.at !== undefined && Number.isFinite(input.at)) {
    window = { from: input.at, to: input.at };
  }
  const gaps = window ? gapsIn(sources, window, now) : [];
  const shortNames = [...new Set(gaps.map((g) => g.source))];
  const chips: TraceChip[] = [];
  for (const [name, n] of counts) {
    const isSource = sources.some((s) => s.name === name);
    const state: TraceChip["state"] = shortNames.includes(name)
      ? "short"
      : isSource
        ? "caught-up"
        : own.has(name)
          ? "here"
          : "pulled";
    const tail = state === "short" ? " · short" : state === "caught-up" ? " · caught up" : "";
    chips.push({ name, spans: n, state, words: `${plural(n, "span")}${tail}` });
  }
  for (const name of shortNames) {
    if (!counts.has(name)) {
      chips.push({ name, spans: 0, state: "short", words: "no spans here · short" });
    }
  }
  const span = Math.max(1, totalMs);
  const frac = (ms: number) => Math.max(0, Math.min(1, (ms - baseMs) / span));
  const hatches: TraceHatch[] = gaps.map((gap) => {
    const hole = gap.kind === "hole";
    return {
      key: `${gap.source}:${gap.kind}`,
      source: gap.source,
      kind: gap.kind,
      lo: spans.length > 0 ? frac(gap.from) : 0,
      hi: spans.length > 0 ? (hole ? frac(gap.to) : 1) : 1,
      label: hole
        ? `spans from ${gap.source} ${holeClock(gap.from)} → ${holeClock(gap.to)}`
        : `spans from ${gap.source} after ${traceClock(gap.from, now)}`,
      tag: hole ? "gone at source" : "not here yet",
    };
  });
  return {
    linked,
    instances: counts.size,
    chips,
    line: lineParts(gaps, now),
    lineSource: shortNames.length === 1 ? shortNames[0]! : null,
    hatches,
    short: gaps.length > 0,
  };
}

function lineParts(gaps: HeldGap[], now: number): HeldPart[] | null {
  const names = [...new Set(gaps.map((g) => g.source))];
  if (names.length === 0) {
    return null;
  }
  if (names.length > 1) {
    return [
      ...names.flatMap((name, i) => [...(i > 0 ? [{ text: ", " }] : []), { text: name, mono: true }]),
      {
        text: " are short inside this trace. Spans that entered at them after where each is read to are not here yet, so this trace may be missing some. It fills in as they catch up.",
      },
    ];
  }
  const name = names[0]!;
  const open = gaps.find((g) => g.kind !== "hole");
  if (open) {
    return [
      { text: name, mono: true },
      { text: " is read to " },
      { text: traceClock(open.from, now), mono: true },
      {
        text: `, inside this trace. Spans that entered at ${name} after that are not here yet, so this trace may be missing some. It fills in as ${name} catches up.`,
      },
    ];
  }
  const hole = gaps[0]!;
  return [
    { text: name, mono: true },
    { text: " dropped its rows from " },
    { text: holeClock(hole.from), mono: true },
    { text: " to " },
    { text: holeClock(hole.to), mono: true },
    { text: ` before they were read, inside this trace. Spans that entered at ${name} then are gone, so this trace may be missing some.` },
  ];
}

/** The rail's "Where it entered" row: the instance, and when and over whose link it was pulled. */
export function enteredRow(
  row: { toposcope?: string; pulled_at?: string | null },
  sources: HeldSource[],
  now: number,
  here: string,
): { value: string; note: string | null } {
  const value = enteredName(row, here);
  const at = row.pulled_at ? Date.parse(row.pulled_at) : NaN;
  if (!Number.isFinite(at)) {
    return { value, note: row.pulled_at === null && (sources.length > 0 || row.toposcope) ? "entered here" : null };
  }
  const over = sources.some((s) => s.name === value) ? value : sources.length === 1 ? sources[0]!.name : null;
  return { value, note: `pulled ${heldClock(at, now)}${over ? ` over ${over}'s link` : ""}` };
}

/** Whether the rail says where a span entered: on a linked instance, or for a span that was pulled. */
export function showsEntered(row: { toposcope?: string; pulled_at?: string | null }, sources: HeldSource[]): boolean {
  return Boolean(row.pulled_at) || sources.length > 0;
}

/** The sources a pulled row could still be on its way from: its own, else (through a relay) any. */
function sourcesOf(row: { toposcope?: string; pulled_at?: string | null }, sources: HeldSource[], here: string): HeldSource[] {
  if (!row.pulled_at && (!row.toposcope || row.toposcope === here)) {
    return [];
  }
  const own = sources.filter((s) => s.name === row.toposcope);
  return own.length > 0 ? own : row.pulled_at ? sources : [];
}

export type ProfileHeld = {
  /** `entered at edge-2 · copied with its span`, as the header says it; null when not linked. */
  entered: { name: string; note: string } | null;
  /** While the span's source is short after the span and no profile is here. */
  notHereYet: HeldPart[] | null;
};

/**
 * What the icicle view says about where its profile entered (#332): the profile's own instance
 * when one is here, else the span's. A profile goes over a link with its span, so while the span's
 * source is read to before the span ends, an empty view says its profile is not here yet.
 */
export function profileHeld(input: {
  profile: { toposcope: string; pulled_at: string | null; stacks: unknown[] } | null;
  span: { ts: string; duration_ms?: number; toposcope?: string; pulled_at?: string | null };
  sources: HeldSource[];
  now: number;
  here: string;
}): ProfileHeld {
  const { profile, span, sources, now, here } = input;
  const found = profile !== null && profile.stacks.length > 0;
  const row = found ? profile! : span;
  const linked = sources.length > 0 || Boolean(row.pulled_at);
  const name = enteredName(row, here);
  const entered = linked ? { name, note: row.pulled_at ? "copied with its span" : "entered here" } : null;
  if (found || profile === null) {
    return { entered, notHereYet: null };
  }
  const from = Date.parse(span.ts);
  if (!Number.isFinite(from)) {
    return { entered, notHereYet: null };
  }
  const window = { from, to: from + Math.max(0, span.duration_ms ?? 0) };
  const gaps = gapsIn(sourcesOf(span, sources, here), window, now).filter((g) => g.kind !== "hole");
  const gap = gaps[0];
  if (!gap) {
    return { entered, notHereYet: null };
  }
  return {
    entered,
    notHereYet: [
      { text: gap.source, mono: true },
      { text: " is read to " },
      { text: traceClock(gap.from, now), mono: true },
      {
        text: `, before this span ended. A profile goes over a link with its span, so it fills in as ${gap.source} catches up.`,
      },
    ],
  };
}
