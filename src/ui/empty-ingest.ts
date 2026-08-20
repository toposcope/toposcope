export function isEmptyIngest(opts: {
  searching: boolean;
  error: string | null;
  eventCount: number;
  q: string;
  ingested: boolean;
}): boolean {
  return (
    !opts.searching &&
    !opts.error &&
    opts.eventCount === 0 &&
    opts.q.trim() === "" &&
    !opts.ingested
  );
}

export function nextIngested(
  prev: boolean,
  mode: "replace" | "append" | "poll",
  json: { ingested?: boolean; events: unknown[]; histogramTotal: number },
): boolean {
  if (json.ingested === true || json.events.length > 0 || json.histogramTotal > 0) {
    return true;
  }
  if (mode === "replace" && json.ingested === false) {
    return false;
  }
  return prev;
}
