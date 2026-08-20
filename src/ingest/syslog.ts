import { incMetric } from "../metrics";
import { retryWhenBusy } from "./backpressure";
import { insertEvents, MAX_BATCH } from "./index";
import { parseSyslog3164 } from "./syslog-parse";
import { createSyslogInsertQueue } from "./syslog-queue";

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

export async function startSyslogUdp(): Promise<void> {
  const port = syslogUdpPort();
  if (port === 0) {
    return;
  }
  const hostname = process.env.HOST ?? "0.0.0.0";
  const queue = createSyslogInsertQueue({
    maxBatch: MAX_BATCH,
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
    await Bun.udpSocket({
      hostname,
      port,
      socket: {
        data(_socket, buf) {
          const text = new TextDecoder().decode(buf);
          const event = parseSyslog3164(text);
          if (!event) {
            return;
          }
          incMetric("syslog_packets");
          queue.enqueue(event);
        },
      },
    });
    console.error(`syslog UDP listening on ${hostname}:${port}`);
  } catch (err) {
    console.error("syslog UDP listen failed", err);
  }
}
