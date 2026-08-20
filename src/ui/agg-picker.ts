import { isAttrIdent, maxAttrFacets } from "../shared/attrs";
import { parseMetricName } from "../shared/metric";
import {
  formatSearchAgg,
  parseSearchAgg,
  type NumericAggOp,
} from "../query/agg";

/** North-star latency attr; pin first when present, and keep as a quiet-window stand-in. */
export const northStarNumericKey = "duration_ms";

/** Same spirit as opt-in attr facets: do not explode 50 keys × 5 ops. */
export const maxNumericPickerKeys = maxAttrFacets;

/** p99 first (north star), then the rest of the numeric reducers. */
export const numericPickerOps = [
  "p99",
  "avg",
  "max",
  "min",
  "sum",
] as const satisfies readonly NumericAggOp[];

export type SeriesPick =
  | { kind: "off" }
  | { kind: "rate" }
  | { kind: "key"; key: string; op: NumericAggOp }
  | { kind: "metric"; name: string };

export function seriesPickFromWidget(
  agg: string | null,
  metric: string | null,
): SeriesPick {
  const name = parseMetricName(metric);
  if (name) {
    return { kind: "metric", name };
  }
  return seriesPickFromAgg(agg);
}

export function pickerMetricNames(
  discovered: string[],
  selected: string | null,
): string[] {
  const ranked: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = parseMetricName(raw);
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    ranked.push(name);
  };
  for (const name of discovered) {
    add(name);
  }
  const keep = parseMetricName(selected);
  let keys = ranked.slice(0, maxNumericPickerKeys);
  if (keep && !keys.includes(keep)) {
    if (keys.length >= maxNumericPickerKeys) {
      keys = [...keys.slice(0, maxNumericPickerKeys - 1), keep];
    } else {
      keys = [...keys, keep];
    }
  }
  return keys;
}

export function seriesPickFromAgg(agg: string | null): SeriesPick {
  try {
    const parsed = parseSearchAgg(agg ?? undefined);
    if (!parsed) {
      return { kind: "off" };
    }
    if (parsed.op === "rate") {
      return { kind: "rate" };
    }
    return { kind: "key", key: parsed.key, op: parsed.op };
  } catch {
    return { kind: "off" };
  }
}

/**
 * Keys shown in the Series picker: duration_ms first when the rollup has it,
 * then API rank, cap 8, always keep the URL's selected key, and fall back to
 * duration_ms when the endpoint is empty (quiet or refused-shape `q`).
 */
export function pickerNumericKeys(
  discovered: string[],
  selectedAgg: string | null,
): string[] {
  const ranked: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const key = raw.trim().toLowerCase();
    if (!isAttrIdent(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    ranked.push(key);
  };

  const names = discovered.map((k) => k.trim().toLowerCase());
  if (names.includes(northStarNumericKey)) {
    add(northStarNumericKey);
  }
  for (const name of names) {
    add(name);
  }

  const pick = seriesPickFromAgg(selectedAgg);
  const selectedKey = pick.kind === "key" ? pick.key : null;

  let keys = ranked.slice(0, maxNumericPickerKeys);
  if (selectedKey && !keys.includes(selectedKey)) {
    if (keys.length >= maxNumericPickerKeys) {
      keys = [...keys.slice(0, maxNumericPickerKeys - 1), selectedKey];
    } else {
      keys = [...keys, selectedKey];
    }
  }
  if (keys.length === 0) {
    return [northStarNumericKey];
  }
  return keys;
}

export function seriesSelectValue(pick: SeriesPick): string {
  switch (pick.kind) {
    case "off":
      return "";
    case "rate":
      return "rate";
    case "key":
      return `k:${pick.key}`;
    case "metric":
      return `m:${pick.name}`;
    default: {
      const _exhaustive: never = pick;
      return _exhaustive;
    }
  }
}

export type SeriesSelectResult = {
  agg: string | null;
  metric: string | null;
};

export function applySeriesSelect(
  value: string,
  prev: SeriesPick,
): SeriesSelectResult {
  if (value.length === 0) {
    return { agg: null, metric: null };
  }
  if (value.startsWith("m:")) {
    const name = parseMetricName(value.slice(2));
    return { agg: null, metric: name };
  }
  const logPrev: SeriesPick =
    prev.kind === "key" || prev.kind === "rate" || prev.kind === "off"
      ? prev
      : { kind: "off" };
  return { agg: aggFromSeriesSelect(value, logPrev), metric: null };
}

export function aggFromSeriesSelect(
  value: string,
  prev: SeriesPick,
): string | null {
  if (value.length === 0) {
    return null;
  }
  if (value === "rate") {
    return "rate";
  }
  const key = value.startsWith("k:") ? value.slice(2) : value;
  if (!isAttrIdent(key)) {
    return null;
  }
  const op = prev.kind === "key" ? prev.op : "p99";
  return formatSearchAgg({ op, key });
}

export function parseNumericPickerOp(raw: string): NumericAggOp | null {
  return numericPickerOps.find((op) => op === raw) ?? null;
}

export function aggFromOpSelect(op: NumericAggOp, pick: SeriesPick): string | null {
  if (pick.kind !== "key") {
    return null;
  }
  return formatSearchAgg({ op, key: pick.key });
}

export function seriesPickerOptions(
  numericKeys: string[],
  metricNames: string[],
  agg: string | null,
  metric: string | null,
): Array<{ value: string; label: string }> {
  const expr = agg === "count" ? null : agg;
  const keys = pickerNumericKeys(numericKeys, expr);
  const metrics = pickerMetricNames(metricNames, metric);
  return [
    { value: "", label: "Count" },
    { value: "rate", label: "Rate" },
    ...keys.map((key) => ({ value: `k:${key}`, label: key })),
    ...metrics.map((name) => ({ value: `m:${name}`, label: name })),
  ];
}
