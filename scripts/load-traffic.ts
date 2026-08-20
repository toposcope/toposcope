import { fakeLogEvent, mix32 } from "../src/shared/fake-event";
import type { Span } from "../src/shared/span";

export const TRACE_LOG_EVERY = 8;
/** Among logs that carry a `trace_id`, 1 in this many is sampled-out. */
export const TRACE_KEEP_EVERY = 4;
export const KEPT_RING = 32;

const services = ["api", "web", "worker", "billing"] as const;

function nonzeroHex(hex: string, width: number): string {
  if (hex.length === width && !/^0+$/.test(hex)) {
    return hex;
  }
  return `a${"0".repeat(Math.max(0, width - 1))}`.slice(0, width);
}

export function liveTraceId(i: number): string {
  const hex = [21, 22, 23, 24]
    .map((salt) => mix32(i, salt).toString(16).padStart(8, "0"))
    .join("");
  return nonzeroHex(hex.slice(0, 32), 32);
}

export function liveSpanId(i: number, salt: number): string {
  const hex =
    mix32(i, salt).toString(16).padStart(8, "0") +
    mix32(i, salt + 1).toString(16).padStart(8, "0");
  return nonzeroHex(hex.slice(0, 16), 16);
}

function pickKept(kept: readonly string[], i: number): string | undefined {
  if (kept.length === 0) {
    return undefined;
  }
  return kept[mix32(i, 33) % kept.length];
}

export function liveLogEvents(opts: {
  start: number;
  count: number;
  now: number;
  marker: string;
  keptIds: readonly string[];
}): {
  events: ReturnType<typeof fakeLogEvent>[];
  joinable: string[];
  sampledOut: string[];
} {
  const events = [];
  const joinable: string[] = [];
  const sampledOut: string[] = [];
  for (let n = 0; n < opts.count; n++) {
    const i = opts.start + n;
    const event = fakeLogEvent({
      i,
      n: 1,
      now: opts.now,
      windowMs: 0,
      marker: opts.marker,
    });
    event.ts = new Date(opts.now - (mix32(i, 30) % 80)).toISOString();
    if (mix32(i, 31) % TRACE_LOG_EVERY === 0) {
      const kept =
        mix32(i, 32) % TRACE_KEEP_EVERY !== 0
          ? pickKept(opts.keptIds, i)
          : undefined;
      if (kept) {
        event.attrs.trace_id = kept;
        joinable.push(kept);
      } else {
        const id = liveTraceId(i + 1_000_003);
        event.attrs.trace_id = id;
        sampledOut.push(id);
      }
    }
    events.push(event);
  }
  return { events, joinable, sampledOut };
}

export function liveMetricPoints(opts: {
  start: number;
  count: number;
  now: number;
}): Array<{
  name: string;
  value: number;
  ts: string;
  labels?: Record<string, string>;
}> {
  const points = [];
  for (let n = 0; n < opts.count; n++) {
    const i = opts.start + n;
    const service = services[mix32(i, 41) % services.length] ?? "api";
    const point: {
      name: string;
      value: number;
      ts: string;
      labels?: Record<string, string>;
    } = {
      name: "cpu_seconds",
      value: 0.08 + (mix32(i, 42) % 21) * 0.04,
      ts: new Date(opts.now).toISOString(),
    };
    if (mix32(i, 43) % 10 >= 7) {
      point.labels = { service };
    }
    points.push(point);
  }
  return points;
}

function span(partial: {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  name: string;
  ts: string;
  duration_ms: number;
  status: Span["status"];
}): Span {
  return { ...partial, attrs: {} };
}

export function liveTraceTree(i: number, now: number): Span[] {
  const traceId = liveTraceId(i);
  const root = liveSpanId(i, 51);
  const mid = liveSpanId(i, 53);
  const leaf = liveSpanId(i, 55);
  const ts = new Date(now).toISOString();
  const rootMs = 80 + (mix32(i, 56) % 320);
  const midMs = Math.max(20, Math.round(rootMs * 0.7));
  const leafMs = Math.max(8, Math.round(midMs * 0.55));
  const wordpress = mix32(i, 40) % 2 === 0;
  if (wordpress) {
    return [
      span({
        trace_id: traceId,
        span_id: root,
        parent_span_id: "",
        service: "nginx",
        name: "GET /wp-admin/post.php",
        ts,
        duration_ms: rootMs,
        status: "ok",
      }),
      span({
        trace_id: traceId,
        span_id: mid,
        parent_span_id: root,
        service: "wordpress",
        name: "do_action(save_post)",
        ts,
        duration_ms: midMs,
        status: "unset",
      }),
      span({
        trace_id: traceId,
        span_id: leaf,
        parent_span_id: mid,
        service: "mysql",
        name: "SELECT wp_options",
        ts,
        duration_ms: leafMs,
        status: mix32(i, 57) % 7 === 0 ? "error" : "ok",
      }),
    ];
  }
  return [
    span({
      trace_id: traceId,
      span_id: root,
      parent_span_id: "",
      service: "api",
      name: "POST /v1/checkout",
      ts,
      duration_ms: rootMs,
      status: "ok",
    }),
    span({
      trace_id: traceId,
      span_id: mid,
      parent_span_id: root,
      service: "api",
      name: "authorize",
      ts,
      duration_ms: midMs,
      status: "ok",
    }),
    span({
      trace_id: traceId,
      span_id: leaf,
      parent_span_id: mid,
      service: "worker",
      name: "enqueue",
      ts,
      duration_ms: leafMs,
      status: "unset",
    }),
  ];
}

export function pushKept(kept: string[], id: string): string[] {
  return [...kept, id].slice(-KEPT_RING);
}

/** Stamp one log in the batch with the newest kept id so View trace has a row. */
export function attachKeptLog(
  events: ReturnType<typeof fakeLogEvent>[],
  keptId: string | undefined,
): boolean {
  const last = events[events.length - 1];
  if (!last || !keptId) {
    return false;
  }
  last.attrs.trace_id = keptId;
  return true;
}
