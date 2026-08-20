import { mix32 } from "../src/shared/fake-event";

export const loadChannels = [
  "json",
  "ndjson",
  "otlp-json",
  "otlp-protobuf",
  "syslog",
] as const;

export type LoadChannel = (typeof loadChannels)[number];

const httpChannels = [
  "json",
  "ndjson",
  "otlp-json",
  "otlp-protobuf",
] as const satisfies readonly LoadChannel[];

/**
 * Syslog is one UDP datagram and one ClickHouse insert per event.
 * Cap it so 10m stays an HTTP ingest load.
 */
export const MAX_SYSLOG_BATCHES = 4;

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = mix32(i, seed) % (i + 1);
    const current = arr[i];
    const swap = arr[j];
    if (current === undefined || swap === undefined) {
      throw new Error("shuffle bounds");
    }
    arr[i] = swap;
    arr[j] = current;
  }
  return arr;
}

export function assignLoadChannels(
  batchCount: number,
  seed: number,
): LoadChannel[] {
  if (batchCount <= 0) {
    return [];
  }
  const order = shuffle(loadChannels, seed);
  const assigned: LoadChannel[] = [];
  for (let i = 0; i < batchCount; i++) {
    const channel = order[i % order.length];
    if (!channel) {
      throw new Error("empty load channel order");
    }
    assigned.push(channel);
  }
  const syslogSlots: number[] = [];
  for (let i = 0; i < assigned.length; i++) {
    if (assigned[i] === "syslog") {
      syslogSlots.push(i);
    }
  }
  const httpOrder = shuffle(httpChannels, seed ^ 1);
  while (syslogSlots.length > MAX_SYSLOG_BATCHES) {
    const i = syslogSlots.pop();
    if (i === undefined) {
      break;
    }
    const http = httpOrder[i % httpOrder.length];
    if (!http) {
      throw new Error("empty http channel order");
    }
    assigned[i] = http;
  }
  return assigned;
}

export type LoadChannelCounts = Record<LoadChannel, number>;

export function countChannels(
  channels: readonly LoadChannel[],
): LoadChannelCounts {
  const counts: LoadChannelCounts = {
    json: 0,
    ndjson: 0,
    "otlp-json": 0,
    "otlp-protobuf": 0,
    syslog: 0,
  };
  for (const channel of channels) {
    counts[channel] += 1;
  }
  return counts;
}

export function formatChannelCounts(counts: LoadChannelCounts): string {
  return loadChannels.map((channel) => `${channel}=${counts[channel]}`).join(" ");
}
