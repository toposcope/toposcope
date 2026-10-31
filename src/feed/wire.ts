import { withArrivalSeq } from "../ingest/arrival-seq";
import { withInsertSlot } from "../ingest/backpressure";
import { onePulledAtATime } from "../ingest/pulled";
import { clickhouseInsertSelectZstd, clickhouseQuery, clickhouseQueryZstd } from "../shared/clickhouse";
import { otherKinds, type FeedReply, type OtherKind } from "./feed";
import { kindFilter } from "./kind-filter";

/**
 * A link's feed on the wire (#327). One body: a 4-byte length, a JSON header (the reply, with each
 * other kind's rows replaced by what its block holds), then one zstd ClickHouse Native block per
 * kind in the header's order. Bun never parses a row of those kinds: they go from `SELECT …
 * FORMAT Native` at the source to `INSERT … SELECT … FROM input(…)` at the puller.
 * Measured 2026-10-27: 0.94 MiB and 0.2 s of CPU for 5 s of a small node, against 2.5 MiB and
 * 0.73 s as zstd JSONEachRow and 47.8 MiB and 1.4 s as today's JSON.
 */

/** Where one kind's block came from: each origin it holds and that origin's range of positions. */
export type BlockOrigins = Array<{ id: string; lo: number; hi: number }>;
export type BlockHeader = { kind: OtherKind; rows: number; bytes: number; origins: BlockOrigins };
export type WireHeader = Omit<FeedReply, "kinds"> & {
  kinds: Partial<Record<OtherKind, { gone: { from: number; to: number } | null; not_sent?: string }>>;
  blocks: BlockHeader[];
};
export type WireFeed = { header: WireHeader; blocks: Map<OtherKind, Uint8Array> };

/** The columns a kind's block carries, in table order, `tenant_id` left out. */
const structures = new Map<OtherKind, Array<{ name: string; type: string }>>();
export async function kindColumns(kind: OtherKind): Promise<Array<{ name: string; type: string }>> {
  const known = structures.get(kind);
  if (known) return known;
  const cols = await clickhouseQuery<{ name: string; type: string }>(
    `SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {t:String} AND name != 'tenant_id' AND default_kind NOT IN ('MATERIALIZED', 'ALIAS') ORDER BY position`,
    { t: kind },
  );
  structures.set(kind, cols);
  return cols;
}

/** Tests only. */
export function forgetKindColumns(): void {
  structures.clear();
}

/**
 * The source's side: a reply read with `positionsOnly`, turned into one body. Each kind with rows
 * in the range is read again in full as one Native block, with the same filter and the reply's end.
 */
export async function encodeFeed(
  reply: FeedReply,
  hereId: string,
  extra: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const blocks: BlockHeader[] = [];
  const bytes: Uint8Array[] = [];
  const kinds: WireHeader["kinds"] = {};
  for (const kind of otherKinds) {
    const page = reply.kinds[kind];
    if (!page) continue;
    kinds[kind] = { gone: page.gone, ...(page.not_sent ? { not_sent: page.not_sent } : {}) };
    if (page.not_sent || page.rows.length === 0) continue;
    const params: Record<string, string> = { tenant_id: "default", after: String(reply.after), through: String(reply.through), here: hereId };
    const filter = kindFilter(reply.q, kind, params);
    if ("not_sent" in filter) continue;
    const where = ["tenant_id = {tenant_id:String}", "seq > {after:UInt64}", "seq <= {through:UInt64}", ...(filter.sql ? [filter.sql] : [])].join(" AND ");
    const cols = (await kindColumns(kind)).map((c) => c.name).join(", ");
    const block = await clickhouseQueryZstd(`SELECT ${cols} FROM ${kind} WHERE ${where} ORDER BY seq FORMAT Native`, params);
    const origins = await clickhouseQuery<{ id: string; lo: string | number; hi: string | number }>(
      `SELECT if(src_id = '', {here:String}, src_id) AS id, min(if(src_id = '', seq, src_seq)) AS lo, max(if(src_id = '', seq, src_seq)) AS hi
       FROM ${kind} WHERE ${where} GROUP BY id`,
      params,
    );
    blocks.push({ kind, rows: page.rows.length, bytes: block.byteLength, origins: origins.map((o) => ({ id: o.id, lo: Number(o.lo), hi: Number(o.hi) })) });
    bytes.push(block);
  }
  const { kinds: _rows, ...rest } = reply;
  const header = new TextEncoder().encode(JSON.stringify({ ...rest, ...extra, kinds, blocks } satisfies WireHeader));
  const out = new Uint8Array(4 + header.byteLength + bytes.reduce((n, b) => n + b.byteLength, 0));
  new DataView(out.buffer).setUint32(0, header.byteLength);
  out.set(header, 4);
  let at = 4 + header.byteLength;
  for (const b of bytes) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

export function decodeFeed(body: Uint8Array): WireFeed {
  if (body.byteLength < 4) throw new Error("not a feed body");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as WireHeader;
  const blocks = new Map<OtherKind, Uint8Array>();
  let at = 4 + length;
  for (const b of header.blocks) {
    blocks.set(b.kind, body.subarray(at, at + b.bytes));
    at += b.bytes;
  }
  if (at !== body.byteLength) throw new Error("feed body is not the length its header says");
  return { header, blocks };
}

/**
 * The puller's side: one kind's block stored as it came, in one statement. Each row takes a
 * position here, in the order sent; keeps where it first entered (`toposcope`, `src_id`,
 * `src_seq`, the source's own when the row entered there); and is skipped when its origin is
 * this instance (a row that left and came back) or a row from that origin is already here.
 */
export function insertPulledNative(
  block: BlockHeader,
  bytes: Uint8Array,
  source: { id: string; name: string },
  hereId: string,
): Promise<{ stored: number }> {
  return onePulledAtATime(() =>
    withInsertSlot(() =>
      withArrivalSeq(block.rows, async (from) => {
        const cols = await kindColumns(block.kind);
        const pick = cols.map((c) => {
          switch (c.name) {
            case "seq":
              return "toUInt64({from:UInt64}) + rowNumberInAllBlocks()";
            case "arrived":
              return "now64(3)";
            case "toposcope":
              return "if(toposcope = '', {sname:String}, toposcope)";
            case "src_id":
              return "if(src_id = '', {sid:String}, src_id)";
            case "src_seq":
              return "if(src_id = '', seq, src_seq)";
            default:
              return c.name;
          }
        });
        const params: Record<string, string> = { from: String(from), sname: source.name, sid: source.id, here: hereId };
        const held = block.origins
          .filter((o) => o.id !== hereId)
          .map((o, i) => {
            params[`o${i}`] = o.id;
            params[`lo${i}`] = String(o.lo);
            params[`hi${i}`] = String(o.hi);
            return `(src_id = {o${i}:String} AND src_seq BETWEEN {lo${i}:UInt64} AND {hi${i}:UInt64})`;
          });
        const origin = "(if(src_id = '', {sid:String}, src_id), if(src_id = '', seq, src_seq))";
        const sql = `INSERT INTO ${block.kind} (tenant_id, ${cols.map((c) => c.name).join(", ")})
          SELECT 'default', ${pick.join(", ")}
          FROM input('${cols.map((c) => `${c.name} ${c.type}`).join(", ").replaceAll("'", "\\'")}')
          WHERE if(src_id = '', {sid:String}, src_id) != {here:String}
          ${held.length > 0 ? `AND ${origin} NOT IN (SELECT src_id, src_seq FROM ${block.kind} WHERE tenant_id = 'default' AND (${held.join(" OR ")}))` : ""}
          FORMAT Native`;
        await clickhouseInsertSelectZstd(sql, bytes, params);
        const stored = await clickhouseQuery<{ n: string | number }>(
          `SELECT count() AS n FROM ${block.kind} WHERE tenant_id = 'default' AND seq >= {from:UInt64} AND seq < {to:UInt64}`,
          { from: String(from), to: String(from + block.rows) },
        );
        return { stored: Number(stored[0]?.n ?? 0) };
      }),
      block.rows,
    ),
  );
}

/** Every block of a decoded feed stored at the puller. */
export async function insertPulledBlocks(
  wire: WireFeed,
  source: { id: string; name: string },
  hereId: string,
): Promise<number> {
  let stored = 0;
  for (const block of wire.header.blocks) {
    stored += (await insertPulledNative(block, wire.blocks.get(block.kind)!, source, hereId)).stored;
  }
  return stored;
}
