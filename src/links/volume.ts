import { decodeFeed, type WireFeed } from "../feed/wire";
import { noteContact, noteVolume } from "./store";

/**
 * What one feed body moved, counted on the side that moved it (#329): rows and bytes for each
 * kind (logs and marks by their share of the header), and each kind's last word (a hole, or why
 * it is not sent), kept on the link for its page.
 */
export function noteWire(linkId: string, body: Uint8Array | WireFeed, at = Date.now()): void {
  const wire = body instanceof Uint8Array ? decodeFeed(body) : body;
  const h = wire.header;
  const headerBytes = Math.max(1, JSON.stringify({ rows: h.rows, marks: h.marks }).length);
  const logRows = h.rows.length;
  const markRows = h.marks.length;
  const share = (n: number) => Math.round((headerBytes * n) / Math.max(1, logRows + markRows));
  noteVolume(linkId, "logs", logRows, share(logRows), at);
  noteVolume(linkId, "marks", markRows, share(markRows), at);
  for (const b of h.blocks) {
    noteVolume(linkId, b.kind, b.rows, b.bytes, at);
  }
  const state: Record<string, { gone?: { from: number; to: number }; not_sent?: string }> = {};
  if (h.gone) {
    state.logs = { gone: h.gone };
  }
  for (const [kind, page] of Object.entries(h.kinds)) {
    if (page?.not_sent || page?.gone) {
      state[kind] = { ...(page.gone ? { gone: page.gone } : {}), ...(page.not_sent ? { not_sent: page.not_sent } : {}) };
    }
  }
  noteContact(linkId, { at, kind_state: JSON.stringify(state) });
}
