import type { FeedMark, FeedRow } from "../feed/feed";
import {
  clickhouseInsertJsonEachRow,
  clickhouseQuery,
  toClickHouseDateTime,
} from "../shared/clickhouse";
import { pickTraceId } from "../shared/ids";
import { allocateArrivalSeq, releaseArrivalSeq } from "./arrival-seq";
import { withInsertSlot } from "./backpressure";

/**
 * Rows pulled over a link (#136), stored as they were at the source: its `e1` and attributes as
 * they are, its `toposcope` (the source's name for a row that entered there unnamed), and its
 * origin beside them. A row whose origin is already here — a retry, two links whose filters
 * overlap, a re-pull, or a row that left here and came back — is not stored again. Each stored
 * row takes a position here, so it can be fed on.
 */
export async function insertPulled(
  rows: FeedRow[],
  source: { name: string },
  hereId: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) {
    return { stored: 0, skipped: 0 };
  }
  const seen = new Set<string>();
  const byOrigin = new Map<string, number[]>();
  for (const row of rows) {
    byOrigin.set(row.origin.id, [...(byOrigin.get(row.origin.id) ?? []), row.origin.seq]);
  }
  for (const [id, seqs] of byOrigin) {
    if (!id || id === hereId) {
      continue;
    }
    const held = await clickhouseQuery<{ s: string | number }>(
      `SELECT src_seq AS s FROM logs
       WHERE tenant_id = 'default' AND src_id = {id:String}
         AND src_seq >= {lo:UInt64} AND src_seq <= {hi:UInt64}`,
      { id, lo: String(Math.min(...seqs)), hi: String(Math.max(...seqs)) },
    );
    for (const row of held) {
      seen.add(`${id}:${Number(row.s)}`);
    }
  }
  const fresh: FeedRow[] = [];
  for (const row of rows) {
    const key = `${row.origin.id}:${row.origin.seq}`;
    if (!row.origin.id || row.origin.id === hereId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    fresh.push(row);
  }
  if (fresh.length === 0) {
    return { stored: 0, skipped: rows.length };
  }
  return withInsertSlot(async () => {
    const seq = await allocateArrivalSeq(fresh.length);
    const arrived = toClickHouseDateTime(new Date().toISOString());
    try {
      const body = fresh
        .map((row, i) =>
          JSON.stringify({
            tenant_id: "default",
            ts: toClickHouseDateTime(row.ts),
            service: row.service,
            host: row.host,
            level: row.level,
            message: row.message,
            attrs: JSON.stringify(row.attrs),
            attr_map: row.attrs,
            trace_id: pickTraceId(row.attrs),
            seq: seq.from + i,
            toposcope: row.toposcope || source.name,
            arrived,
            src_id: row.origin.id,
            src_seq: row.origin.seq,
          }),
        )
        .join("\n");
      await clickhouseInsertJsonEachRow(body);
      return { stored: fresh.length, skipped: rows.length - fresh.length };
    } finally {
      releaseArrivalSeq(seq);
    }
  });
}

/**
 * Marks that came with a link (#138), stored under the instance they were posted at: their id
 * gains `@<instance>`, so two sources that both post `deploy-api-v1.4` stay two marks, each
 * cutting its own window. A mark posted here that came back is not stored again; a mark the
 * source closed later arrives again closed, and the closed one is the one read.
 */
export async function insertPulledMarks(marks: FeedMark[], source: { name: string }, here: string): Promise<number> {
  const keep = marks
    .map((mark) => ({ mark, origin: mark.toposcope || source.name }))
    .filter(({ origin }) => origin && origin !== here);
  if (keep.length === 0) {
    return 0;
  }
  return withInsertSlot(async () => {
    const seq = await allocateArrivalSeq(keep.length);
    try {
      const body = keep
        .map(({ mark, origin }, i) =>
          JSON.stringify({
            tenant_id: "default",
            ts: toClickHouseDateTime(mark.ts),
            kind: mark.kind,
            service: mark.service,
            title: mark.title,
            attrs: mark.attrs,
            id: mark.id.endsWith(`@${origin}`) ? mark.id : `${mark.id}@${origin}`,
            end_ts: mark.end_ts ? toClickHouseDateTime(mark.end_ts) : null,
            seq: seq.from + i,
            toposcope: origin,
          }),
        )
        .join("\n");
      await clickhouseInsertJsonEachRow(body, "change_marks");
      return keep.length;
    } finally {
      releaseArrivalSeq(seq);
    }
  });
}
