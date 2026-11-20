import type { FacetValue } from "@/types";

/** Sheet 48d/48e: on no matches, each field the query names offers its other values to switch to. */
export type OtherValuesLine = { field: string; label: string; values: FacetValue[] };

const plural: Record<string, string> = { level: "levels", service: "services", host: "hosts" };

export function otherValuesLabel(field: string): string {
  return `Other ${plural[field] ?? `${field} values`}`;
}

/**
 * A field's facet counts leave out that field's own filter, so they already count
 * "the rest of the query, any value of this field": the values the query does not name are
 * the ones worth switching to. Fields with nothing else counted are left out.
 */
export function otherValuesLines(
  active: Partial<Record<string, string | string[]>>,
  counts: Record<string, FacetValue[] | undefined>,
  cap = 6,
): OtherValuesLine[] {
  const lines: OtherValuesLine[] = [];
  for (const [field, raw] of Object.entries(active)) {
    if (raw === undefined) {
      continue;
    }
    const named = new Set((Array.isArray(raw) ? raw : [raw]).map((v) => v.toLowerCase()));
    const values = (counts[field] ?? []).filter((item) => item.n > 0 && !named.has(item.v.toLowerCase())).slice(0, cap);
    if (values.length > 0) {
      lines.push({ field, label: otherValuesLabel(field), values });
    }
  }
  return lines;
}
