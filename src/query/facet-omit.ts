/**
 * Sidebar facets omit their own field so `level:error` still lists every level.
 * Top-N passes `omit=0` so the chart follows the full `q`, not just the window.
 */
export function parseFacetOmitSelf(raw: string | undefined | null): boolean {
  if (raw == null || raw.trim() === "") {
    return true;
  }
  const value = raw.trim().toLowerCase();
  return value !== "0" && value !== "false";
}
