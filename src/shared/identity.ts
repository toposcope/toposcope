/**
 * Stamp `version` from OTEL `service.version` when the sender did not already
 * set `version`. Hunt uses `version:` like any other attr — not a core column.
 * Does not invent `customer` or `flag`; those stay collector remaps.
 */

function identityString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function take(
  attrs: Record<string, unknown>,
  name: string,
): { key: string; value: unknown } | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (key.toLowerCase() === name) {
      return { key, value };
    }
  }
  return undefined;
}

export function liftIdentities(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attrs) {
    return attrs;
  }
  const next: Record<string, unknown> = { ...attrs };
  const existing = take(next, "version");
  const fromService = take(next, "service.version");
  const version =
    identityString(existing?.value) ?? identityString(fromService?.value);
  if (!version) {
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (fromService) {
    delete next[fromService.key];
  }
  if (existing) {
    delete next[existing.key];
  }
  return { version, ...next };
}
