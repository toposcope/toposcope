export type IngestedKind = "true" | "probe" | "omit";

/** Full searches that already have window hits skip the store probe. Load-more and live deltas omit the flag. */
export function ingestedKind(opts: {
  eventsOnly: boolean;
  isDelta: boolean;
  total: number;
  eventCount: number;
}): IngestedKind {
  if (opts.eventsOnly) {
    return "omit";
  }
  if (opts.total > 0 || opts.eventCount > 0) {
    return "true";
  }
  if (opts.isDelta) {
    return "omit";
  }
  return "probe";
}
