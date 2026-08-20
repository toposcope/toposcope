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
  const out: Record<string, string> = {};
  if (!attrs) {
    return out;
  }
  for (const [rawKey, value] of Object.entries(attrs)) {
    if (Object.keys(out).length >= maxAttrKeysPerEvent) {
      break;
    }
    const key = rawKey.toLowerCase();
    if (!isAttrIdent(key) || key in out) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      if (value.length === 0) {
        continue;
      }
      out[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = String(value);
      continue;
    }
    if (typeof value === "object") {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
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
