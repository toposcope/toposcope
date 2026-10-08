import { maxAttrKeysPerEvent } from "../shared/attrs";
import { isMetricIdent, type MetricBuckets, type MetricPoint } from "../shared/metric";
import type { MetricKind } from "../shared/metric-kinds";
import type { Losses } from "./otlp-reply";
import type { RunningTotals } from "./running-totals";

type AnyVal = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
type Attr = { key?: string; value?: AnyVal };

const DELTA = 1;
const CUMULATIVE = 2;
/** DataPointFlags.NO_RECORDED_VALUE: the series went away; there is no value to store. */
const NO_RECORDED_VALUE = 1;

const baseline =
  "running totals seen for the first time from a series that was already running, taken as its baseline";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A label's text. Lists and maps are not labels. */
function labelText(value: AnyVal | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue.length > 0 ? value.stringValue : undefined;
  }
  if (value.intValue !== undefined) {
    return String(value.intValue);
  }
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) {
    return String(value.doubleValue);
  }
  if (typeof value.boolValue === "boolean") {
    return String(value.boolValue);
  }
  return undefined;
}

/** `service.name` and `host.name` arrive as `service` and `host`, as they do on logs. */
function labelKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === "service.name") {
    return "service";
  }
  return key === "host.name" ? "host" : key;
}

/** The point's attributes first, then the resource's. */
function pointLabels(
  point: Attr[] | undefined,
  resource: Attr[] | undefined,
  losses: Losses,
): Record<string, string> {
  const out: Record<string, string> = {};
  let kept = 0;
  let pastCap = 0;
  let badName = 0;
  for (const attr of [...(point ?? []), ...(resource ?? [])]) {
    const text = labelText(attr?.value);
    if (!attr?.key || text === undefined) {
      continue;
    }
    const key = labelKey(attr.key);
    if (!isMetricIdent(key)) {
      badName += 1;
      continue;
    }
    if (key in out) {
      continue;
    }
    if (kept >= maxAttrKeysPerEvent) {
      pastCap += 1;
      continue;
    }
    out[key] = text;
    kept += 1;
  }
  if (pastCap > 0) {
    losses.trim(`labels past the ${maxAttrKeysPerEvent}-label cap`);
  }
  if (badName > 0) {
    losses.trim("labels under a name that cannot be stored");
  }
  return out;
}

/** Milliseconds, or 0 when the point does not say. */
function msFromNano(nano: unknown): number {
  const n = typeof nano === "number" ? nano : Number(nano);
  return Number.isFinite(n) && n > 0 ? n / 1_000_000 : 0;
}

/** A series is a name and its labels. */
function seriesKey(name: string, labels: Record<string, string>): string {
  const sorted = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  return String(Bun.hash(`${name}\u0000${JSON.stringify(sorted)}`));
}

function numberValue(point: Record<string, unknown>): number | undefined {
  const raw = point.asDouble ?? point.asInt;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function metricName(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const name = raw.trim().toLowerCase();
  return isMetricIdent(name) ? name : undefined;
}

/** Bucket counts under rising upper bounds; one more count, last, for what was above them all. */
type Buckets = { le: number[]; n: number[] };

/** More buckets than this in one point are not kept. An exporter sends 15, or up to 160. */
const maxBuckets = 1_024;
/** An exponential histogram is kept no finer than this: eight buckets to a doubling, 9% wide. */
const maxScale = 3;

const misfit = "histogram buckets that do not fit their bounds";

function counts(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: number[] = [];
  for (const item of raw) {
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isFinite(n) || n < 0) {
      return null;
    }
    out.push(n);
  }
  return out;
}

/** A histogram's buckets as sent, "none" when it sent none, "misfit" when they cannot be read. */
function explicitBuckets(point: Record<string, unknown>): Buckets | "none" | "misfit" {
  const n = counts(point.bucketCounts);
  const le = Array.isArray(point.explicitBounds) ? point.explicitBounds.map((bound) => Number(bound)) : [];
  if (n === null) {
    return "misfit";
  }
  if (n.length === 0) {
    return "none";
  }
  const rising = le.every((bound, i) => Number.isFinite(bound) && (i === 0 || bound > le[i - 1]!));
  return n.length === le.length + 1 && rising && n.length <= maxBuckets ? { le, n } : "misfit";
}

/** One side of an exponential histogram, by bucket index at the kept scale. */
function foldSide(side: unknown, shrink: number): Map<number, number> | null {
  const rec = asRecord(side);
  const sent = counts(rec?.bucketCounts);
  const offset = Number(rec?.offset ?? 0);
  if (sent === null || !Number.isInteger(offset)) {
    return null;
  }
  const out = new Map<number, number>();
  sent.forEach((count, i) => {
    if (count > 0) {
      const index = Math.floor((offset + i) / shrink);
      out.set(index, (out.get(index) ?? 0) + count);
    }
  });
  return out;
}

/**
 * An exponential histogram under explicit bounds. Its buckets double every
 * `2^scale` of them; a scale finer than the kept one is folded down, so series
 * line up on the same bounds. The edge its lowest bucket starts at is sent as a
 * bound with no count, so that bucket is not read as starting at zero.
 */
function exponentialBuckets(point: Record<string, unknown>): Buckets | "none" | "misfit" {
  const scale = Number(point.scale ?? 0);
  const zero = Number(point.zeroCount ?? 0);
  if (!Number.isInteger(scale) || !Number.isFinite(zero) || zero < 0) {
    return "misfit";
  }
  const kept = Math.min(scale, maxScale);
  const positive = foldSide(point.positive, 2 ** (scale - kept));
  const negative = foldSide(point.negative, 2 ** (scale - kept));
  if (!positive || !negative) {
    return "misfit";
  }
  if (positive.size === 0 && negative.size === 0 && zero === 0) {
    return "none";
  }
  /** The value a bucket index ends at. */
  const edge = (index: number) => 2 ** (index * 2 ** -kept);
  const le: number[] = [];
  const n: number[] = [];
  if (negative.size > 0) {
    const from = Math.max(...negative.keys());
    const to = Math.min(...negative.keys());
    le.push(-edge(from + 1));
    n.push(0);
    for (let index = from; index >= to; index--) {
      le.push(-edge(index));
      n.push(negative.get(index) ?? 0);
    }
  }
  if (zero > 0 || negative.size > 0) {
    le.push(0);
    n.push(zero);
  }
  if (positive.size > 0) {
    const from = Math.min(...positive.keys());
    const to = Math.max(...positive.keys());
    le.push(edge(from));
    n.push(0);
    for (let index = from; index <= to; index++) {
      le.push(edge(index + 1));
      n.push(positive.get(index) ?? 0);
    }
  }
  if (le.length >= maxBuckets || le.some((bound) => !Number.isFinite(bound))) {
    return "misfit";
  }
  // Nothing is above an exponential histogram's last bucket.
  return { le, n: [...n, 0] };
}

/**
 * The buckets worth a row: a bound stays when something was counted under it,
 * or under the next one, whose bucket it starts. Null when nothing was counted.
 */
function sparse(le: number[], n: number[]): Buckets | null {
  const keptLe: number[] = [];
  const keptN: number[] = [];
  for (let i = 0; i < le.length; i++) {
    if ((n[i] ?? 0) > 0 || (n[i + 1] ?? 0) > 0) {
      keptLe.push(le[i]!);
      keptN.push(n[i] ?? 0);
    }
  }
  const above = n[le.length] ?? 0;
  return keptN.some((count) => count > 0) || above > 0 ? { le: keptLe, n: [...keptN, above] } : null;
}

export type MappedMetrics = {
  points: MetricPoint[];
  /** A histogram's buckets, one for each of its points that counted something. */
  buckets: MetricBuckets[];
  /** The kind each stored name came as. */
  kinds: Map<string, MetricKind>;
};

/**
 * What fits a point: a gauge as it is, an up-down counter's running total as a
 * gauge too, a counter as the amount per interval. A histogram is its count
 * and sum, as the counters `<name>.count` and `<name>.sum`, and its buckets
 * under `<name>`; an exponential histogram is brought to the same shape. A
 * summary keeps its count and sum only: its quantiles were worked out by the
 * sender and cannot be added up. A counter, a histogram or a summary sent as a
 * running total is turned into the amount since it was last seen, through
 * `totals`. Everything else is counted in `losses` and the rest of the request
 * still lands.
 */
export function mapOtlpMetrics(
  payload: unknown,
  losses: Losses,
  totals: RunningTotals,
): MappedMetrics {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.resourceMetrics)) {
    throw new Error("resourceMetrics is required");
  }
  const points: MetricPoint[] = [];
  const buckets: MetricBuckets[] = [];
  const kinds = new Map<string, MetricKind>();

  for (const rm of root.resourceMetrics) {
    const resourceAttrs = asRecord(asRecord(rm)?.resource)?.attributes as Attr[] | undefined;
    for (const sm of list(asRecord(rm)?.scopeMetrics)) {
      for (const rawMetric of list(asRecord(sm)?.metrics)) {
        const metric = asRecord(rawMetric);
        if (!metric) {
          continue;
        }
        const name = metricName(metric.name);
        const gauge = asRecord(metric.gauge);
        const sum = asRecord(metric.sum);
        const histogram = asRecord(metric.histogram);
        const exponential = asRecord(metric.exponentialHistogram);
        const summary = asRecord(metric.summary);
        const distribution = histogram ?? exponential;
        const dataPoints = list((gauge ?? sum ?? distribution ?? summary)?.dataPoints);
        if (dataPoints.length === 0) {
          continue;
        }
        if (!name) {
          losses.reject("a metric name that cannot be stored", dataPoints.length);
          continue;
        }

        const temporality = Number((sum ?? distribution)?.aggregationTemporality ?? 0);
        const monotonic = sum?.isMonotonic === true;
        const amount = Boolean(distribution || (sum && monotonic));
        if (amount && temporality !== DELTA && temporality !== CUMULATIVE) {
          losses.reject("a sum or histogram that does not say its temporality", dataPoints.length);
          continue;
        }
        // A running total of something that only goes up is not a level: it is converted below.
        // A summary is always a total since its series started.
        const running = summary ? true : amount && temporality === CUMULATIVE;
        const kind: MetricKind = sum && (monotonic || temporality === DELTA) ? "counter" : "gauge";

        for (const rawPoint of dataPoints) {
          const point = asRecord(rawPoint);
          if (!point || (Number(point.flags ?? 0) & NO_RECORDED_VALUE) !== 0) {
            continue;
          }
          const timeMs = msFromNano(point.timeUnixNano) || Date.now();
          const ts = new Date(timeMs).toISOString();
          const labels = pointLabels(point.attributes as Attr[] | undefined, resourceAttrs, losses);
          /** The amounts to store: as sent, or since the series was last seen. Null sets a baseline. */
          const amounts = (values: number[], bounds?: number[]): number[] | null =>
            running
              ? totals.advance(
                  seriesKey(name, labels),
                  msFromNano(point.startTimeUnixNano),
                  timeMs,
                  values,
                  bounds,
                )
              : values;
          if (distribution || summary) {
            const count = Number(point.count ?? 0);
            if (!Number.isFinite(count)) {
              losses.reject("a value that is not a number");
              continue;
            }
            const hasSum = typeof point.sum === "number" && Number.isFinite(point.sum);
            const sent = summary ? "none" : histogram ? explicitBuckets(point) : exponentialBuckets(point);
            if (sent === "misfit") {
              losses.trim(misfit);
            }
            const kept = typeof sent === "object" ? sent : null;
            const since = amounts(
              [count, hasSum ? (point.sum as number) : 0, ...(kept?.n ?? [])],
              kept ? [...kept.le, Number.POSITIVE_INFINITY] : undefined,
            );
            if (since === null) {
              losses.note(baseline);
              continue;
            }
            kinds.set(`${name}.count`, "counter");
            if (hasSum) {
              kinds.set(`${name}.sum`, "counter");
            }
            if (kept) {
              kinds.set(name, "histogram");
            }
            // A running total that did not move is what a delta exporter would not have sent.
            if (running && since[0] === 0) {
              continue;
            }
            points.push({ ts, name: `${name}.count`, value: since[0]!, labels });
            if (hasSum) {
              points.push({ ts, name: `${name}.sum`, value: since[1]!, labels });
            }
            const row = kept ? sparse(kept.le, since.slice(2)) : null;
            if (row) {
              buckets.push({ ts, name, labels, ...row });
            }
            continue;
          }
          const value = numberValue(point);
          if (value === undefined) {
            losses.reject("a value that is not a number");
            continue;
          }
          const since = amounts([value]);
          if (since === null) {
            losses.note(baseline);
            continue;
          }
          kinds.set(name, kind);
          if (running && since[0] === 0) {
            continue;
          }
          points.push({ ts, name, value: since[0]!, labels });
        }
      }
    }
  }
  return { points, buckets, kinds };
}
