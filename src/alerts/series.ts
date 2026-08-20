import { countLogs, search } from "../query";
import {
  formatSearchAgg,
  InvalidAggError,
  LogsScanBudgetError,
  parseSearchAgg,
  type SearchAggResult,
} from "../query/agg";

export { seriesLabel as alertSeriesLabel } from "../query/agg";

export type AlertSeries = {
  expr: string | null;
  count: number;
  value: number;
  refused: boolean;
  reason?: string;
};

export function seriesFromSearch(
  expr: string | null,
  total: number,
  agg: SearchAggResult | undefined,
): AlertSeries {
  if (!expr) {
    return { expr: null, count: total, value: total, refused: false };
  }
  if (!agg || agg.source === "refused" || agg.stat == null) {
    return {
      expr,
      count: total,
      value: 0,
      refused: true,
      reason: agg?.reason ?? "no stat",
    };
  }
  return {
    expr: agg.expr,
    count: total,
    value: agg.stat,
    refused: false,
  };
}

/** Count/stat for /run. Event-page refuse must not mark a valid histogram total refused. */
export function applyHistogramCountRefuse(
  series: AlertSeries,
  scan: { histogram: boolean; reason?: string } | undefined,
): AlertSeries {
  if (series.expr !== null || !scan?.histogram) {
    return series;
  }
  return { ...series, refused: true, reason: scan.reason };
}

export async function evaluateAlertSeries(saved: {
  query: string;
  range: string | null;
  from_ts: string | null;
  to_ts: string | null;
  agg: string | null;
}): Promise<AlertSeries> {
  const filters = {
    q: saved.query,
    range: saved.range ?? undefined,
    from: saved.from_ts ?? undefined,
    to: saved.to_ts ?? undefined,
  };
  let parsed;
  try {
    parsed = parseSearchAgg(saved.agg ?? undefined);
  } catch (err) {
    if (err instanceof InvalidAggError) {
      return {
        expr: saved.agg,
        count: 0,
        value: 0,
        refused: true,
        reason: err.message,
      };
    }
    throw err;
  }
  if (!parsed) {
    try {
      const count = await countLogs(filters);
      return { expr: null, count, value: count, refused: false };
    } catch (err) {
      if (err instanceof LogsScanBudgetError) {
        return {
          expr: null,
          count: 0,
          value: 0,
          refused: true,
          reason: err.message,
        };
      }
      throw err;
    }
  }
  const expr = formatSearchAgg(parsed);
  const result = await search({ ...filters, events: "0", agg: expr });
  return seriesFromSearch(expr, result.total, result.agg);
}

