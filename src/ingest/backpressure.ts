export class InsertBackpressureError extends Error {
  constructor() {
    super("ingest backpressured");
    this.name = "InsertBackpressureError";
  }
}

/**
 * How much ingest may wait on ClickHouse at once. ClickHouse gathers small inserts into one write
 * and answers each once it is written (async inserts, on by default), so an insert waits up to
 * 200 ms however small it is. Counting inserts alone, 32 senders of a few lines each filled the
 * limit and the rest were told 429. So inserts are weighed by their rows: as many rows may wait as
 * 32 full OTLP batches did before, which bounds the memory they hold, and small inserts take many
 * more places. The count stays bounded too, leaving ClickHouse room for searches and monitors.
 */
export const maxRowsInFlight = 32 * 1_024;
export const maxInsertsInFlight = 256;
let inFlight = 0;
let rowsInFlight = 0;

/** What is waiting on ClickHouse now; for tests. */
export function insertsInFlight(): { inserts: number; rows: number } {
  return { inserts: inFlight, rows: rowsInFlight };
}

export function isClickHouseBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /MEMORY_LIMIT|TOO_MANY_SIMULTANEOUS|TIMEOUT_EXCEEDED|OVERCOMMIT|limit for.*queries|MEMORY_LIMIT_EXCEEDED/i.test(
    message,
  );
}

/**
 * Runs one insert of `rows` rows, or refuses it while ClickHouse is busy. An insert larger than
 * the whole row limit still runs when nothing else waits, so no batch is refused for ever.
 */
export async function withInsertSlot<T>(fn: () => Promise<T>, rows = 1): Promise<T> {
  const weight = Math.max(1, Math.floor(rows));
  if (inFlight >= maxInsertsInFlight || (rowsInFlight > 0 && rowsInFlight + weight > maxRowsInFlight)) {
    throw new InsertBackpressureError();
  }
  inFlight += 1;
  rowsInFlight += weight;
  try {
    return await fn();
  } catch (err) {
    if (isClickHouseBusy(err)) {
      throw new InsertBackpressureError();
    }
    throw err;
  } finally {
    inFlight -= 1;
    rowsInFlight -= weight;
  }
}

/** UDP syslog cannot return 429; retry the insert while ClickHouse is busy. */
export async function retryWhenBusy<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 40;
  const delayMs = opts?.delayMs ?? 20;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof InsertBackpressureError) || i === attempts - 1) {
        throw err;
      }
      if (delayMs > 0) {
        await Bun.sleep(delayMs * (i + 1));
      }
    }
  }
  throw last;
}
