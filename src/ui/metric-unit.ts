/**
 * A unit as the app sent it (#104), without braces: `{request}` reads `request`, and `1`
 * (a plain number) reads as nothing. No conversion.
 */
export function printUnit(unit: string | null | undefined): string {
  const raw = (unit ?? "").trim();
  if (!raw || raw === "1") {
    return "";
  }
  return raw.replace(/[{}]/g, "");
}

/** "320 GiBy", or the number alone when there is no unit. */
export function withUnit(value: string, unit: string | null | undefined): string {
  const printed = printUnit(unit);
  return printed ? `${value} ${printed}` : value;
}
