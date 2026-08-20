import { MAX_BATCH } from "../src/ingest";
import { toOtlpTracesJson } from "../src/ingest/otlp-traces";
import { encodeOtlpTracesProtobuf } from "../src/ingest/otlp-traces-protobuf";
import { loadChannels, type LoadChannel } from "./load-channel";
import {
  LIVE_HTTP_IN_FLIGHT,
  encodeLoadBatch,
  postMetrics,
  postTraces,
  sendEncoded,
} from "./load-http";
import type { LiveArgs } from "./load-rates";
import { envValue } from "../src/shared/env";
import {
  KEPT_RING,
  attachKeptLog,
  liveLogEvents,
  liveMetricPoints,
  liveTraceTree,
  pushKept,
} from "./load-traffic";

const TICK_MS = 200;
const MAX_WAVE = 50_000;
const TREES_PER_POST = Math.floor(MAX_BATCH / 3);

export function liveDueCount(acc: number, rate: number): { n: number; acc: number } {
  if (rate <= 0) {
    return { n: 0, acc: 0 };
  }
  const cap = Math.min(MAX_WAVE, Math.max(MAX_BATCH, Math.floor(rate * 2)));
  let next = acc;
  if (next > cap * 2) {
    next = cap * 2;
  }
  const n = Math.min(Math.floor(next), cap);
  return { n, acc: next - n };
}

export async function addIngested(
  counts: { logs: number; metrics: number; traces: number },
  key: "logs" | "metrics" | "traces",
  pending: Promise<number>,
): Promise<void> {
  const n = await pending;
  counts[key] += n;
}

export async function mapLimit(
  count: number,
  limit: number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  if (count <= 0) {
    return;
  }
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) {
        return;
      }
      await fn(index);
    }
  };
  const n = Math.min(limit, count);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

function trimRing(ids: string[]): void {
  if (ids.length > KEPT_RING) {
    ids.splice(0, ids.length - KEPT_RING);
  }
}

export type LiveRunResult = {
  marker: string;
  logs: number;
  metrics: number;
  traces: number;
  joinable: string[];
  sampledOut: string[];
  kept: string[];
};

function liveChannel(tick: number): LoadChannel {
  const channel = loadChannels[tick % loadChannels.length] ?? "json";
  if (channel === "syslog" && tick % 8 !== 7) {
    return "json";
  }
  return channel;
}

export async function runLiveLoad(
  args: LiveArgs & {
    url?: string;
    token?: string;
    syslogHost?: string;
    syslogPort?: number;
    quiet?: boolean;
    marker?: string;
  },
): Promise<LiveRunResult> {
  const env = {
    url: args.url ?? envValue("TOPOSCOPE_URL") ?? "http://127.0.0.1:8080",
    token: args.token ?? envValue("TOPOSCOPE_INGEST_TOKEN") ?? "toposcope-ingest",
  };
  const syslog = {
    host: args.syslogHost ?? process.env.SYSLOG_UDP_HOST ?? "127.0.0.1",
    port: args.syslogPort ?? Number(process.env.SYSLOG_UDP_PORT ?? "5514"),
  };
  const marker = args.marker ?? `live${Date.now()}`;
  const udp = await Bun.udpSocket({});
  const started = Date.now();
  const deadline = args.forMs > 0 ? started + args.forMs : 0;
  let stop = false;
  const onStop = () => {
    stop = true;
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  let logAcc = 0;
  let metricAcc = 0;
  let traceAcc = 0;
  let logSeq = 0;
  let metricSeq = 0;
  let traceSeq = 0;
  let tick = 0;
  let kept: string[] = [];
  const joinable: string[] = [];
  const sampledOut: string[] = [];
  const counts = { logs: 0, metrics: 0, traces: 0 };
  let lastPrint = started;
  let lastAcc = started - TICK_MS;
  let printedLogs = 0;
  let printedMetrics = 0;
  let printedTraces = 0;

  const postTraceBatches = async (
    batchTrees: Array<{ spans: ReturnType<typeof liveTraceTree>; proto: boolean }>,
    proto: boolean,
  ): Promise<void> => {
    const chunks = Math.ceil(batchTrees.length / TREES_PER_POST);
    await mapLimit(chunks, LIVE_HTTP_IN_FLIGHT, async (i) => {
      if (stop) {
        return;
      }
      const slice = batchTrees.slice(
        i * TREES_PER_POST,
        (i + 1) * TREES_PER_POST,
      );
      if (slice.length === 0) {
        return;
      }
      const spans = slice.flatMap((tree) => tree.spans);
      const payload = toOtlpTracesJson(spans);
      await addIngested(
        counts,
        "traces",
        postTraces(
          env,
          proto ? encodeOtlpTracesProtobuf(payload) : JSON.stringify(payload),
          proto,
        ),
      );
    });
  };

  try {
    if (!args.quiet) {
      console.log(
        `load:live logs=${args.logs}/s metrics=${args.metrics}/s traces=${args.traces}/s` +
          (args.forMs > 0 ? ` for=${args.forMs}ms` : " until SIGINT"),
      );
    }
    while (!stop && (deadline === 0 || Date.now() < deadline)) {
      const now = Date.now();
      const dt = Math.max(0, (now - lastAcc) / 1000);
      lastAcc = now;
      logAcc += args.logs * dt;
      metricAcc += args.metrics * dt;
      traceAcc += args.traces * dt;
      const logsDue = liveDueCount(logAcc, args.logs);
      const metricsDue = liveDueCount(metricAcc, args.metrics);
      const tracesDue = liveDueCount(traceAcc, args.traces);
      logAcc = logsDue.acc;
      metricAcc = metricsDue.acc;
      traceAcc = tracesDue.acc;
      const logN = logsDue.n;
      const metricN = metricsDue.n;
      const traceN = tracesDue.n;

      const trees = [];
      for (let n = 0; n < traceN; n++) {
        const spans = liveTraceTree(traceSeq + n, now);
        const id = spans[0]?.trace_id;
        if (id) {
          kept = pushKept(kept, id);
        }
        trees.push({
          spans,
          proto: (traceSeq + n) % 2 === 1,
        });
      }
      traceSeq += traceN;

      const channel = liveChannel(tick);
      const logSeq0 = logSeq;
      logSeq += logN;
      const logChunks = Math.ceil(logN / MAX_BATCH);
      const metricSeq0 = metricSeq;
      metricSeq += metricN;
      const metricChunks = Math.ceil(metricN / MAX_BATCH);

      const jsonTrees = trees.filter((tree) => !tree.proto);
      const protoTrees = trees.filter((tree) => tree.proto);

      await Promise.all([
        mapLimit(logChunks, LIVE_HTTP_IN_FLIGHT, async (i) => {
          if (stop) {
            return;
          }
          const start = logSeq0 + i * MAX_BATCH;
          const chunkN = Math.min(MAX_BATCH, logN - i * MAX_BATCH);
          const planned = liveLogEvents({
            start,
            count: chunkN,
            now,
            marker,
            keptIds: kept,
          });
          if (i === 0 && attachKeptLog(planned.events, kept[kept.length - 1])) {
            const id = kept[kept.length - 1];
            if (id) {
              planned.joinable.push(id);
            }
          }
          joinable.push(...planned.joinable);
          sampledOut.push(...planned.sampledOut);
          trimRing(joinable);
          trimRing(sampledOut);
          await addIngested(
            counts,
            "logs",
            sendEncoded(
              env,
              encodeLoadBatch(channel, planned.events),
              udp,
              syslog,
            ),
          );
        }),
        mapLimit(metricChunks, LIVE_HTTP_IN_FLIGHT, async (i) => {
          if (stop) {
            return;
          }
          const start = metricSeq0 + i * MAX_BATCH;
          const chunkN = Math.min(MAX_BATCH, metricN - i * MAX_BATCH);
          await addIngested(
            counts,
            "metrics",
            postMetrics(
              env,
              liveMetricPoints({ start, count: chunkN, now }),
            ),
          );
        }),
        postTraceBatches(jsonTrees, false),
        postTraceBatches(protoTrees, true),
      ]);

      const printed = Date.now();
      if (!args.quiet && printed - lastPrint >= 2000) {
        const elapsed = Math.max(0.001, (printed - started) / 1000);
        const window = Math.max(0.001, (printed - lastPrint) / 1000);
        const logs = (counts.logs - printedLogs) / window;
        const metrics = (counts.metrics - printedMetrics) / window;
        const traces = (counts.traces - printedTraces) / 3 / window;
        console.log(
          `  live ${elapsed.toFixed(0)}s  logs ${logs.toFixed(1)}/s  metrics ${metrics.toFixed(1)}/s  traces ${traces.toFixed(1)} trees/s`,
        );
        lastPrint = printed;
        printedLogs = counts.logs;
        printedMetrics = counts.metrics;
        printedTraces = counts.traces;
      }
      tick += 1;
      const sleepMs = TICK_MS - (Date.now() - now);
      if (sleepMs > 0 && !stop) {
        const remain = deadline > 0 ? deadline - Date.now() : sleepMs;
        await Bun.sleep(Math.max(0, Math.min(sleepMs, remain)));
      }
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    udp.close();
  }
  if (!args.quiet) {
    console.log(
      `load:live sent logs=${counts.logs} metrics=${counts.metrics} spans=${counts.traces} marker=${marker}`,
    );
  }
  return {
    marker,
    logs: counts.logs,
    metrics: counts.metrics,
    traces: counts.traces,
    joinable,
    sampledOut,
    kept,
  };
}
