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
