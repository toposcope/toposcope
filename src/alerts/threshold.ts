/** Positive finite threshold. Integers stay legal; rate `0.5` is too. */
export function parseThreshold(value: unknown): number | { error: string } {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return { error: "threshold must be > 0" };
  }
  return n;
}
