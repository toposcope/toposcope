import { maxAttrKeysPerEvent } from "../shared/attrs";
import { isMetricIdent, type MetricPoint } from "../shared/metric";
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

export type MappedMetrics = {
  points: MetricPoint[];
  /** The kind each stored name came as. */
  kinds: Map<string, MetricKind>;
};

/**
 * What fits a point: a gauge as it is, an up-down counter's running total as a
 * gauge too, a counter as the amount per interval, and a histogram as two
 * counters, `<name>.count` and `<name>.sum`. A counter or a histogram sent as
 * a running total is turned into the amount since it was last seen, through
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
        const unstored =
          asRecord(metric.exponentialHistogram) !== undefined
            ? "exponential histograms"
            : asRecord(metric.summary) !== undefined
              ? "summaries"
              : undefined;
        const dataPoints = list(
          (gauge ?? sum ?? histogram ?? asRecord(metric.exponentialHistogram) ?? asRecord(metric.summary))
            ?.dataPoints,
        );
        if (dataPoints.length === 0) {
          continue;
        }
        if (unstored) {
          losses.reject(unstored, dataPoints.length);
          continue;
        }
        if (!name) {
          losses.reject("a metric name that cannot be stored", dataPoints.length);
          continue;
        }

        const temporality = Number((sum ?? histogram)?.aggregationTemporality ?? 0);
        const monotonic = sum?.isMonotonic === true;
        const amount = Boolean(histogram || (sum && monotonic));
        if (amount && temporality !== DELTA && temporality !== CUMULATIVE) {
          losses.reject("a sum or histogram that does not say its temporality", dataPoints.length);
          continue;
        }
        // A running total of something that only goes up is not a level: it is converted below.
        const running = amount && temporality === CUMULATIVE;
        const kind: MetricKind = histogram || (sum && (monotonic || temporality === DELTA)) ? "counter" : "gauge";

        for (const rawPoint of dataPoints) {
          const point = asRecord(rawPoint);
          if (!point || (Number(point.flags ?? 0) & NO_RECORDED_VALUE) !== 0) {
            continue;
          }
          const timeMs = msFromNano(point.timeUnixNano) || Date.now();
          const ts = new Date(timeMs).toISOString();
          const labels = pointLabels(point.attributes as Attr[] | undefined, resourceAttrs, losses);
          /** The amounts to store: as sent, or since the series was last seen. Null sets a baseline. */
          const amounts = (values: number[]): number[] | null =>
            running
              ? totals.advance(seriesKey(name, labels), msFromNano(point.startTimeUnixNano), timeMs, values)
              : values;
          if (histogram) {
            const count = Number(point.count ?? 0);
            if (!Number.isFinite(count)) {
              losses.reject("a value that is not a number");
              continue;
            }
            const hasSum = typeof point.sum === "number" && Number.isFinite(point.sum);
            const since = amounts([count, hasSum ? (point.sum as number) : 0]);
            if (since === null) {
              losses.note(baseline);
              continue;
            }
            kinds.set(`${name}.count`, "counter");
            if (hasSum) {
              kinds.set(`${name}.sum`, "counter");
            }
            // A running total that did not move is what a delta exporter would not have sent.
            if (running && since[0] === 0) {
              continue;
            }
            points.push({ ts, name: `${name}.count`, value: since[0]!, labels });
            if (hasSum) {
              points.push({ ts, name: `${name}.sum`, value: since[1]!, labels });
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
  return { points, kinds };
}
