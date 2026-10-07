export const attrIdent = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
export const maxAttrKeysPerEvent = 50;
export const maxAttrFacets = 8;
export const maxAttrKeys = 200;
export const maxPromotedCols = 3;

const reserved = new Set(["level", "service", "host", "ts", "message", "tenant_id"]);

export function isAttrIdent(key: string): boolean {
  return attrIdent.test(key) && !reserved.has(key);
}

/** Flatten attrs to string values. Insert uses this for both `attr_map` and the JSON `attrs` column. */
export function flattenAttrs(
  attrs: Record<string, unknown> | undefined,
): Record<string, string> {
  return flattenAttrsCounted(attrs).attrs;
}

/** An attribute's stored text, or nothing when it has no value to store. */
function attrText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return undefined;
}

/**
 * flattenAttrs, and how many attributes with a value it left out: `pastCap`
 * beyond the per-row cap, `badName` under a name a row cannot hold.
 */
export function flattenAttrsCounted(attrs: Record<string, unknown> | undefined): {
  attrs: Record<string, string>;
  pastCap: number;
  badName: number;
} {
  const out: Record<string, string> = {};
  let kept = 0;
  let pastCap = 0;
  let badName = 0;
  for (const [rawKey, value] of Object.entries(attrs ?? {})) {
    const text = attrText(value);
    if (text === undefined) {
      continue;
    }
    const key = rawKey.toLowerCase();
    if (!isAttrIdent(key)) {
      badName += 1;
      continue;
    }
    if (key in out) {
      continue;
    }
    if (kept >= maxAttrKeysPerEvent) {
      pastCap += 1;
      continue;
    }
    out[key] = text;
    kept += 1;
  }
  return { attrs: out, pastCap, badName };
}

export function parseAttrFacets(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim().toLowerCase();
    if (!isAttrIdent(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
    if (out.length >= maxAttrFacets) {
      break;
    }
  }
  return out;
}

/** Hunt-table extra columns. Cap 3; same ident rules as attr facets. */
export function parsePromotedCols(raw: unknown): string[] {
  const parts: string[] = [];
  if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      parts.push(part);
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        parts.push(item);
      }
    }
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.trim().toLowerCase();
    if (!isAttrIdent(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
    if (out.length >= maxPromotedCols) {
      break;
    }
  }
  return out;
}

export function formatPromotedCols(keys: readonly string[]): string | null {
  const parsed = parsePromotedCols(keys);
  return parsed.length > 0 ? parsed.join(",") : null;
}
