export class InsertBackpressureError extends Error {
  constructor() {
    super("ingest backpressured");
    this.name = "InsertBackpressureError";
  }
}

const maxInFlight = 32;
let inFlight = 0;

export function isClickHouseBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /MEMORY_LIMIT|TOO_MANY_SIMULTANEOUS|TIMEOUT_EXCEEDED|OVERCOMMIT|limit for.*queries|MEMORY_LIMIT_EXCEEDED/i.test(
    message,
  );
}

export async function withInsertSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxInFlight) {
    throw new InsertBackpressureError();
  }
  inFlight += 1;
  try {
    return await fn();
  } catch (err) {
    if (isClickHouseBusy(err)) {
      throw new InsertBackpressureError();
    }
    throw err;
  } finally {
    inFlight -= 1;
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
