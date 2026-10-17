import {
  clickhouseInsertJsonEachRow,
  clickhouseQuery,
  toClickHouseDateTime,
} from "../shared/clickhouse";

/**
 * The arrival sequence (#133): a per-instance counter stamped on each log row at ingest, in the
 * order rows arrive. It is reserved this far ahead in `arrival_seq`, so a restart starts above
 * every number handed out before it, even after retention has aged out every row.
 */
export const arrivalSeqBlock = 100_000;

export type ArrivalSeqRange = { from: number; to: number };

let next = 0;
let reservedTo = 0;
let loading: Promise<void> | null = null;
let reserving: Promise<void> | null = null;
const inflight = new Set<ArrivalSeqRange>();

async function load(): Promise<void> {
  const [stored, reserved] = await Promise.all([
    clickhouseQuery<{ n: string | number }>("SELECT max(seq) AS n FROM logs"),
    clickhouseQuery<{ n: string | number }>("SELECT max(reserved) AS n FROM arrival_seq"),
  ]);
  const top = Math.max(Number(stored[0]?.n ?? 0) || 0, Number(reserved[0]?.n ?? 0) || 0);
  next = top + 1;
  reservedTo = top;
}

async function reserve(upTo: number): Promise<void> {
  const to = upTo + arrivalSeqBlock;
  await clickhouseInsertJsonEachRow(
    JSON.stringify({ reserved: to, at: toClickHouseDateTime(new Date().toISOString()) }),
    "arrival_seq",
  );
  reservedTo = Math.max(reservedTo, to);
}

/**
 * Where the counter stands, read once. Boot calls it, so "settled" is true from the first
 * request: a source restarted with nothing new to ingest still tells a puller how far it is.
 */
export async function loadArrivalSeq(): Promise<void> {
  if (next === 0) {
    loading ??= load().catch((err) => {
      loading = null;
      throw err;
    });
    await loading;
  }
}

/** Numbers for `n` rows about to be inserted, in arrival order. Release them when the insert ends. */
export async function allocateArrivalSeq(n: number): Promise<ArrivalSeqRange> {
  await loadArrivalSeq();
  while (next + n - 1 > reservedTo) {
    reserving ??= reserve(next + n - 1).finally(() => {
      reserving = null;
    });
    await reserving;
  }
  const range = { from: next, to: next + Math.max(0, n - 1) };
  next = range.to + 1;
  inflight.add(range);
  return range;
}

/** The insert is over, stored or not: its numbers no longer hold back what is settled. */
export function releaseArrivalSeq(range: ArrivalSeqRange): void {
  inflight.delete(range);
}

/**
 * Settled up to N: no insert still running holds a number at or below N, so every row stamped
 * at or below N that was stored can be read. Inserts finish out of order; this does not.
 */
export function arrivalSeqSettled(): number {
  if (next === 0) {
    return 0;
  }
  let lowest = next;
  for (const range of inflight) {
    lowest = Math.min(lowest, range.from);
  }
  return lowest - 1;
}

/** Tests only: forget the loaded counter, as a restart would. */
export function resetArrivalSeqForTests(): void {
  next = 0;
  reservedTo = 0;
  loading = null;
  reserving = null;
  inflight.clear();
}
