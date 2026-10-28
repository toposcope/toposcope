/**
 * A unit as the app sent it (#104), without braces: `{request}` reads `request`, and `1`
 * (a plain number) reads as nothing. No conversion.
 */
export function printUnit(unit: string | null | undefined): string {
  const raw = (unit ?? "").trim();
  if (!raw || raw === "1") {
    return "";
  }
  // #169: the byte units read as people write them; every other unit as it was sent.
  const written = readableUnits[raw];
  return written ?? raw.replace(/[{}]/g, "");
}

/** UCUM's byte units as people write them (#169); `s` and `ms` already read that way. */
const readableUnits: Record<string, string> = { By: "B", KiBy: "KiB", MiBy: "MiB", GiBy: "GiB" };

/** "320 GiBy", or the number alone when there is no unit. */
export function withUnit(value: string, unit: string | null | undefined): string {
  const printed = printUnit(unit);
  return printed ? `${value} ${printed}` : value;
}

const counted = ["", "one", "two", "three", "four", "five"];

type UnitGroup = { kind: string; unit: string; sources: readonly string[]; first: string; last: string };

/**
 * When one source changed unit or kind (#331, 33e), the times its new line starts: each group
 * from the one source ends before the next begins. Null when sources disagree instead.
 */
export function unitChanges(groups: ReadonlyArray<UnitGroup> | undefined): Array<{ from: string; to: string }> | null {
  if (!groups || groups.length < 2) {
    return null;
  }
  const source = groups[0]!.sources[0];
  const one = groups.every((g) => g.sources.length === 1 && g.sources[0] === source);
  const inTurn = groups.every((g, i) => i === 0 || Date.parse(groups[i - 1]!.last) < Date.parse(g.first));
  if (!one || !inTurn) {
    return null;
  }
  return groups.slice(1).map((g, i) => ({ from: groups[i]!.last, to: g.first }));
}

/** A mark as a unit change looks for it: only a deploy changes what a sender sends. */
type MarkAt = { ts: string; kind: string; title: string };

/**
 * The deploy a unit change happened around (#331, 33e): the one between the old line's last
 * point and the new line's first, give or take a minute, nearest the new line's start.
 */
export function unitChangeMark<M extends MarkAt>(
  change: { from: string; to: string },
  marks: readonly M[] | undefined,
  slackMs = 60_000,
): M | null {
  const lo = Date.parse(change.from) - slackMs;
  const hi = Date.parse(change.to) + slackMs;
  const to = Date.parse(change.to);
  let best: M | null = null;
  for (const mark of marks ?? []) {
    const t = Date.parse(mark.ts);
    if (mark.kind !== "deploy" || t < lo || t > hi) continue;
    if (!best || Math.abs(t - to) < Math.abs(Date.parse(best.ts) - to)) best = mark;
  }
  return best;
}

/**
 * The one line a panel says when its points came in more than one unit or kind (#331, 33e):
 * `two units: ms (edge-1), s (here)`. One source that changed unit reads as a line ending and
 * another starting: `two units: ms until 12:58, s after`, or `ms until ▲ api v2.0, s after`
 * when a deploy marks it.
 */
export function unitsDifferWords(
  groups: ReadonlyArray<UnitGroup> | undefined,
  /** The panel's marks: a deploy the unit changed around names the change (`ms until ▲ api v2.0`). */
  marks?: readonly MarkAt[],
): string | null {
  if (!groups || groups.length < 2) {
    return null;
  }
  const units = new Set(groups.map((g) => g.unit)).size > 1;
  const kinds = new Set(groups.map((g) => g.kind)).size > 1;
  const word = (g: (typeof groups)[number]) => {
    const unit = printUnit(g.unit) || "no unit";
    return units && kinds ? `${g.kind} ${unit}` : kinds ? g.kind : unit;
  };
  const n = groups.length;
  const head = `${counted[n] ?? String(n)} ${units ? "units" : "kinds"}`;
  const changes = unitChanges(groups);
  if (changes) {
    const until = (i: number) => {
      const mark = unitChangeMark(changes[i]!, marks);
      return mark ? `▲ ${mark.title}` : changes[i]!.to.slice(11, 16);
    };
    const parts = groups.map((g, i) => (i === n - 1 ? `${word(g)} after` : `${word(g)} until ${until(i)}`));
    return `${head}: ${parts.join(", ")}`;
  }
  return `${head}: ${groups.map((g) => `${word(g)} (${g.sources.join(", ") || "here"})`).join(", ")}`;
}
