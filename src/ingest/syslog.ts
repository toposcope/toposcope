import { incMetric } from "../metrics";
import { retryWhenBusy } from "./backpressure";
import { insertEvents, MAX_BATCH } from "./index";
import { parseSyslog3164 } from "./syslog-parse";
import { createSyslogInsertQueue, type SyslogDropReason } from "./syslog-queue";

/** #465: rows waiting for ClickHouse, at most; 20 batches of MAX_BATCH. */
export const SYSLOG_MAX_QUEUED = 10_000;
const DROP_LOG_EVERY_MS = 60_000;

type DropReason = SyslogDropReason | "unparsed";

/** Counts drops for /api/metrics and writes at most one stderr line a minute while they happen. */
export function createDropTally(opts: { now?: () => number; log?: (line: string) => void } = {}): (reason: DropReason, n: number) => void {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(line));
  const since: Record<DropReason, number> = { queue_full: 0, insert_failed: 0, unparsed: 0 };
  let lastLog = -Infinity;
  return (reason, n) => {
    incMetric(`syslog_dropped_${reason}`, n);
    since[reason] += n;
    const t = now();
    if (t - lastLog < DROP_LOG_EVERY_MS) {
      return;
    }
    lastLog = t;
    log(`syslog dropped rows: queue full ${since.queue_full}, insert failed ${since.insert_failed}, unparsed ${since.unparsed}`);
    since.queue_full = 0;
    since.insert_failed = 0;
    since.unparsed = 0;
  };
}

export function syslogUdpPort(): number {
  const raw = process.env.SYSLOG_UDP_PORT;
  if (raw === undefined || raw === "") {
    return 5514;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
}

/**
 * Starts the listener. The returned function stops taking packets and resolves
 * once every row already taken is inserted.
 */
export async function startSyslogUdp(): Promise<() => Promise<void>> {
  const port = syslogUdpPort();
  if (port === 0) {
    return async () => {};
  }
  const hostname = process.env.HOST ?? "0.0.0.0";
  const drop = createDropTally();
  const queue = createSyslogInsertQueue({
    maxBatch: MAX_BATCH,
    maxQueued: SYSLOG_MAX_QUEUED,
    onDrop: drop,
    insert: async (events) => {
      const n = await retryWhenBusy(() => insertEvents(events));
      incMetric("ingest_events", n);
      return n;
    },
    onError: (err) => {
      console.error("syslog ingest failed", err);
    },
  });
  try {
    const socket = await Bun.udpSocket({
      hostname,
      port,
      socket: {
        data(_socket, buf) {
          const text = new TextDecoder().decode(buf);
          const event = parseSyslog3164(text);
          if (!event) {
            drop("unparsed", 1);
            return;
          }
          if (queue.enqueue(event)) {
            incMetric("syslog_packets");
          }
        },
      },
    });
    console.error(`syslog UDP listening on ${hostname}:${port}`);
    return async () => {
      socket.close();
      await queue.idle();
    };
  } catch (err) {
    console.error("syslog UDP listen failed", err);
    return async () => {};
  }
}
