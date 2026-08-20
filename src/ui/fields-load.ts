import type { FieldsWave } from "../shared/fields";

export const FIELDS_SLOW_AFTER_MS = 1600;
export const FIELDS_SLOW_MIN_SPAN_MS = 6 * 60 * 60 * 1000;

export function fieldsWaveLabel(wave: FieldsWave): string {
  switch (wave) {
    case "keys":
      return "Counting keys";
    case "values":
      return "Counting distinct values";
    case "suggest":
      return "Checking metric labels";
    default: {
      const _never: never = wave;
      return _never;
    }
  }
}

export function fieldsCatalogSlow(
  spanMs: number,
  elapsedMs: number,
  wave: FieldsWave | null,
): boolean {
  return (
    wave !== null &&
    spanMs >= FIELDS_SLOW_MIN_SPAN_MS &&
    elapsedMs > FIELDS_SLOW_AFTER_MS
  );
}

export function fieldsSlowAdvice(rangeLabel: string, keyCount: number): string {
  if (keyCount > 0) {
    return `${rangeLabel} over ${keyCount} keys — a narrower range returns sooner`;
  }
  return `${rangeLabel} — a narrower range returns sooner`;
}
