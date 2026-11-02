import type { Context } from "hono";
import { maxAttrKeysPerEvent } from "../shared/attrs";
import { isMetricIdent, metricDescriptionOf, metricUnitOf, type MetricBuckets, type MetricPoint } from "../shared/metric";
import { rememberMetricDescriptions } from "../shared/metric-descriptions";
import { rememberMetricKinds, type MetricKind } from "../shared/metric-kinds";
import { rememberMetricUnits } from "../shared/metric-units";
import { incMetric } from "../metrics";
import { InsertBackpressureError } from "./backpressure";
import { insertErrorMessage, MAX_BODY_BYTES } from "./index";
import { insertMetricBuckets, insertMetricPoints } from "./metrics";
import { BodyTooLargeError, readCappedBytes } from "./otlp-body";
import { sparse } from "./otlp-metrics";
import { decodeWriteRequest, type PromLabel, type WriteRequest } from "./prometheus-protobuf";
import { RunningTotals } from "./running-totals";
import { InvalidSnappyError, SnappyTooLargeError, snappyDecompress } from "./snappy";

/**
 * Prometheus remote write 1.0 (#417). Every series becomes the points OTLP
 * would have made: a counter's running total the amount per interval, a
 * classic histogram's `_bucket` series its buckets, `_count` and `_sum` the
 * counters `<name>.count` and `<name>.sum`, the rest a gauge.
 */

/** `MetricMetadata.type` as Prometheus numbers it. */
const COUNTER = 1;
const GAUGE = 2;
const HISTOGRAM = 3;
const SUMMARY = 5;

/**
 * What each family is, from the metadata Prometheus sends in requests of their
 * own, about once a minute. Until it arrives a name's suffix decides.
 */
export class FamilyTypes {
  private readonly families = new Map<string, { type: number; help: string; unit: string }>();

  constructor(private readonly max = 50_000) {}

  learn(req: WriteRequest): void {
    for (const meta of req.metadata) {
      // Names are stored in lower case, as on OTLP.
      const family = meta.family.toLowerCase();
      if (!family) continue;
      this.families.delete(family);
      this.families.set(family, { type: meta.type, help: meta.help, unit: meta.unit });
      if (this.families.size > this.max) {
        this.families.delete(this.families.keys().next().value!);
      }
    }
  }

  get(family: string): number | undefined {
    return this.families.get(family)?.type;
  }

  about(family: string): { help: string; unit: string } | undefined {
    return this.families.get(family);
  }
}

/** One histogram's bucket amounts at one time, by upper bound, as they arrive. */
type Pending = {
  name: string;
  labels: Record<string, string>;
  ts: string;
  /** Amount since last seen, under each `le`: counted up to that bound, as Prometheus counts. */
  upTo: Map<number, number>;
  arrivedMs: number;
};

/**
 * Prometheus shards a histogram's `_bucket` series across parallel requests,
 * so one histogram's buckets reach here in pieces. They wait until the same
 * histogram's next scrape arrives, or `waitMs`, and are written whole.
 */
export class BucketAssembler {
  /** By histogram (name and labels), then by time. */
  private readonly pending = new Map<string, Map<string, Pending>>();

  constructor(private readonly waitMs = 30_000) {}

  get size(): number {
    let n = 0;
    for (const times of this.pending.values()) n += times.size;
    return n;
  }

  /** Adds one bucket's amount. Returns the histograms an older scrape left that are now whole. */
  add(series: string, name: string, labels: Record<string, string>, ts: string, le: number, amount: number, nowMs: number): MetricBuckets[] {
    let times = this.pending.get(series);
    if (!times) {
      times = new Map();
      this.pending.set(series, times);
    }
    let at = times.get(ts);
    if (!at) {
      at = { name, labels, ts, upTo: new Map(), arrivedMs: nowMs };
      times.set(ts, at);
    }
    at.upTo.set(le, amount);
    const done: MetricBuckets[] = [];
    for (const [time, older] of times) {
      if (time < ts) {
        times.delete(time);
        const row = whole(older);
        if (row) done.push(row);
      }
    }
    return done;
  }

  /** The histograms that have waited long enough, or all of them. */
  take(nowMs: number, all = false): MetricBuckets[] {
    const done: MetricBuckets[] = [];
    for (const [series, times] of this.pending) {
      for (const [time, at] of times) {
        if (all || nowMs - at.arrivedMs >= this.waitMs) {
          times.delete(time);
          const row = whole(at);
          if (row) done.push(row);
        }
      }
      if (times.size === 0) this.pending.delete(series);
    }
    return done;
  }
}

/** Counts up to each bound, as buckets between bounds, with what was above the last. */
function whole(at: Pending): MetricBuckets | null {
  const bounds = [...at.upTo.keys()].sort((a, b) => a - b);
  const finite = bounds.filter((bound) => Number.isFinite(bound));
  const n: number[] = [];
  let below = 0;
  for (const bound of finite) {
    const upTo = at.upTo.get(bound)!;
    n.push(Math.max(0, upTo - below));
    below = Math.max(below, upTo);
  }
  const all = at.upTo.get(Number.POSITIVE_INFINITY);
  const row = sparse(finite, [...n, all === undefined ? 0 : Math.max(0, all - below)]);
  return row ? { ts: at.ts, name: at.name, labels: at.labels, ...row } : null;
}

export type Dropped = {
  /** Stale markers and other samples with no number to store. */
  notANumber: number;
  /** Summary quantiles: worked out by the sender, they cannot be added up. */
  quantiles: number;
  nativeHistograms: number;
  /** A name or label that cannot be stored. */
  badName: number;
  /** Running totals seen for the first time: kept as the baseline. */
  baseline: number;
};

export type MappedWrite = {
  points: MetricPoint[];
  buckets: MetricBuckets[];
  kinds: Map<string, MetricKind>;
  units: Map<string, string>;
  descriptions: Map<string, string>;
  dropped: Dropped;
};

/** `10.0.0.5:9100` → `10.0.0.5`; `[::1]:9100` → `::1`. */
export function hostOfInstance(instance: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(instance);
  if (v6) return v6[1]!;
  const colon = instance.lastIndexOf(":");
  return colon > 0 && instance.indexOf(":") === colon && /^\d+$/.test(instance.slice(colon + 1))
    ? instance.slice(0, colon)
    : instance;
}

/** A series' labels, without `__name__`, `le` and `quantile`; `job` gives `service` and `instance` `host`. */
function seriesLabels(raw: PromLabel[], dropped: Dropped): Record<string, string> {
  const out: Record<string, string> = {};
  let kept = 0;
  for (const { name, value } of raw) {
    const key = name.trim().toLowerCase();
    if (key.startsWith("__") || key === "le" || key === "quantile" || value === "") continue;
    if (!isMetricIdent(key)) {
      dropped.badName += 1;
      continue;
    }
    if (key in out || kept >= maxAttrKeysPerEvent) continue;
    out[key] = value;
    kept += 1;
  }
  if (out.service === undefined && out.job !== undefined && kept < maxAttrKeysPerEvent) {
    out.service = out.job;
    kept += 1;
  }
  if (out.host === undefined && out.instance !== undefined && kept < maxAttrKeysPerEvent) {
    out.host = hostOfInstance(out.instance);
  }
  return out;
}

function seriesKey(name: string, labels: Record<string, string>, le?: number): string {
  const sorted = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  return String(Bun.hash(`prom\u0000${name}\u0000${JSON.stringify(sorted)}\u0000${le ?? ""}`));
}

function label(raw: PromLabel[], name: string): string | undefined {
  return raw.find((l) => l.name === name)?.value;
}

function stripSuffix(name: string, suffix: string): string | null {
  return name.length > suffix.length && name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
}

type Role =
  | { as: "gauge" | "counter"; name: string; family: string }
  | { as: "count" | "sum"; name: string; family: string }
  | { as: "bucket"; name: string; family: string; le: number }
  | { as: "quantile" };

/**
 * What a series is. Metadata that calls a name a gauge wins over its suffix;
 * otherwise `_total` is a counter, and `_bucket`, `_count` and `_sum` are
 * parts of a histogram or a summary, as Prometheus reserves them.
 */
function roleOf(name: string, raw: PromLabel[], types: FamilyTypes): Role | null {
  if (label(raw, "quantile") !== undefined) return { as: "quantile" };
  if (types.get(name) === GAUGE) return { as: "gauge", name, family: name };
  const bucket = stripSuffix(name, "_bucket");
  const le = label(raw, "le");
  if (bucket && le !== undefined) {
    const bound = le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le);
    return Number.isNaN(bound) ? null : { as: "bucket", name: bucket, family: bucket, le: bound };
  }
  for (const [suffix, as] of [["_count", "count"], ["_sum", "sum"]] as const) {
    const base = stripSuffix(name, suffix);
    const type = base ? types.get(base) : undefined;
    if (base && (type === undefined || type === HISTOGRAM || type === SUMMARY)) {
      return { as, name: `${base}.${as}`, family: base };
    }
  }
  const total = stripSuffix(name, "_total");
  if (total || types.get(name) === COUNTER) {
    return { as: "counter", name, family: total ?? name };
  }
  return { as: "gauge", name, family: name };
}

/** Maps one request. Buckets that make a histogram whole come back in `buckets`; the rest wait in `assembler`. */
export function mapPrometheusWrite(
  req: WriteRequest,
  totals: RunningTotals,
  types: FamilyTypes,
  assembler: BucketAssembler,
  nowMs: number = Date.now(),
): MappedWrite {
  types.learn(req);
  const points: MetricPoint[] = [];
  const buckets: MetricBuckets[] = [];
  const kinds = new Map<string, MetricKind>();
  const units = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const dropped: Dropped = { notANumber: 0, quantiles: 0, nativeHistograms: 0, badName: 0, baseline: 0 };

  for (const series of req.timeseries) {
    dropped.nativeHistograms += series.histograms;
    const rawName = label(series.labels, "__name__")?.trim().toLowerCase() ?? "";
    if (!rawName || series.samples.length === 0) continue;
    const role = roleOf(rawName, series.labels, types);
    if (!role) continue;
    if (role.as === "quantile") {
      dropped.quantiles += series.samples.length;
      continue;
    }
    // A recording rule's `:` cannot be stored.
    if (!isMetricIdent(role.name)) {
      dropped.badName += series.samples.length;
      continue;
    }
    const labels = seriesLabels(series.labels, dropped);
    // A text exposition names a counter's family `x_total`, OpenMetrics `x`.
    const about = types.about(role.family) ?? types.about(rawName);
    const describe = (stored: string) => {
      const description = metricDescriptionOf(about?.help);
      const unit = metricUnitOf(about?.unit);
      if (description) descriptions.set(stored, description);
      if (unit) units.set(stored, unit);
    };
    const running = role.as !== "gauge";
    const key = seriesKey(role.name, labels, role.as === "bucket" ? role.le : undefined);
    for (const sample of series.samples) {
      if (!Number.isFinite(sample.value)) {
        dropped.notANumber += 1;
        continue;
      }
      const timeMs = sample.timestamp > 0 ? sample.timestamp : nowMs;
      const ts = new Date(timeMs).toISOString();
      if (!running) {
        kinds.set(role.name, "gauge");
        describe(role.name);
        points.push({ ts, name: role.name, value: sample.value, labels });
        continue;
      }
      // Prometheus says nothing of when a series started: the first total is its baseline.
      const since = totals.advance(key, 0, timeMs, [sample.value]);
      if (since === null) {
        dropped.baseline += 1;
        continue;
      }
      if (role.as === "bucket") {
        kinds.set(role.name, "histogram");
        describe(role.name);
        buckets.push(...assembler.add(seriesKey(role.name, labels), role.name, labels, ts, role.le, since[0]!, nowMs));
        continue;
      }
      kinds.set(role.name, "counter");
      if (role.as !== "count") describe(role.name);
      if (since[0] === 0) continue;
      points.push({ ts, name: role.name, value: since[0]!, labels });
    }
  }
  return { points, buckets, kinds, units, descriptions, dropped };
}

const totals = new RunningTotals();
const types = new FamilyTypes();
const assembler = new BucketAssembler();

async function writeBuckets(rows: MetricBuckets[], meta: Pick<MappedWrite, "units" | "descriptions"> = { units: new Map(), descriptions: new Map() }): Promise<void> {
  if (rows.length > 0) await insertMetricBuckets(rows, meta);
}

let sweeping: ReturnType<typeof setInterval> | undefined;

/** Writes the histograms that waited long enough. Runs every 5 s once a request has come. */
function sweep(): void {
  sweeping ??= setInterval(() => {
    writeBuckets(assembler.take(Date.now())).catch((err) => {
      console.error(`prometheus remote write: buckets not written: ${insertErrorMessage(err)}`);
    });
  }, 5_000);
  sweeping.unref?.();
}

/** On a stop: what still waits is written now. */
export async function flushPrometheusBuckets(): Promise<void> {
  await writeBuckets(assembler.take(Date.now(), true));
}

export async function prometheusWriteRoute(c: Context): Promise<Response> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("io.prometheus.write.v2")) {
    return c.json({ error: "Remote write 2.0 is not taken: send 1.0 (prometheus.WriteRequest)" }, 415);
  }
  const encoding = (c.req.header("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "snappy") {
    return c.json({ error: `Content-Encoding ${encoding} is not taken: send snappy` }, 415);
  }
  let req: WriteRequest;
  try {
    const raw = await readCappedBytes(c.req.raw.body, MAX_BODY_BYTES);
    if (raw.byteLength === 0) {
      return c.json({ error: "Empty body" }, 400);
    }
    req = decodeWriteRequest(encoding === "snappy" ? snappyDecompress(raw, MAX_BODY_BYTES) : raw);
  } catch (err) {
    if (err instanceof BodyTooLargeError || err instanceof SnappyTooLargeError) {
      return c.json({ error: err.message }, 413);
    }
    if (err instanceof InvalidSnappyError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Invalid remote write body" }, 400);
  }
  sweep();
  const mapped = mapPrometheusWrite(req, totals, types, assembler, Date.now());
  try {
    await rememberMetricKinds(mapped.kinds);
    await rememberMetricUnits(mapped.units);
    await rememberMetricDescriptions(mapped.descriptions);
    await writeBuckets(mapped.buckets, mapped);
    const ingested = await insertMetricPoints(mapped.points, mapped);
    incMetric("ingest_metrics", ingested);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof InsertBackpressureError) {
      return c.json({ error: "ClickHouse is busy" }, 429, { "retry-after": "1" });
    }
    return c.json({ error: insertErrorMessage(err) }, 503);
  }
}
