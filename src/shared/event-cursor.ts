/**
 * Load more's cursor (#133): the oldest row's time and, when it has one, its arrival sequence,
 * so rows that share a millisecond page through without one dropped or repeated. Rows stored
 * before the sequence existed carry none and page by time alone, as they always did.
 */
export function eventCursor(event: { ts: string; seq?: number }): string {
  return event.seq && event.seq > 0 ? `${event.ts}~${event.seq}` : event.ts;
}

export function parseEventCursor(cursor: string): { ts: string; seq: number | null } {
  const at = cursor.lastIndexOf("~");
  if (at > 0) {
    const seq = Number(cursor.slice(at + 1));
    if (Number.isSafeInteger(seq) && seq > 0) {
      return { ts: cursor.slice(0, at), seq };
    }
  }
  return { ts: cursor, seq: null };
}
