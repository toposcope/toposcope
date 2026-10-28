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

/**
 * The one line a panel says when its points came in more than one unit or kind (#331, 33e):
 * `two units: ms (edge-1), s (here)`. One source that changed unit reads as a line ending and
 * another starting: `two units: ms until 12:58, s after`.
 */
export function unitsDifferWords(
  groups: ReadonlyArray<{ kind: string; unit: string; sources: readonly string[]; first: string; last: string }> | undefined,
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
  const one = groups[0]!.sources.length === 1 && groups.every((g) => g.sources.length === 1 && g.sources[0] === groups[0]!.sources[0]);
  const inTurn = groups.every((g, i) => i === 0 || Date.parse(groups[i - 1]!.last) < Date.parse(g.first));
  if (one && inTurn) {
    const parts = groups.map((g, i) => (i === n - 1 ? `${word(g)} after` : `${word(g)} until ${groups[i + 1]!.first.slice(11, 16)}`));
    return `${head}: ${parts.join(", ")}`;
  }
  return `${head}: ${groups.map((g) => `${word(g)} (${g.sources.join(", ") || "here"})`).join(", ")}`;
}
