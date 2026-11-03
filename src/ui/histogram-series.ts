import type { HistogramSplit } from "../query/histogram";
import { levelOrder } from "./level";
import { chartColor, chartOtherDark, levelHex } from "./chart-palette";
import type { HistogramBucket, LogLevel } from "./types";


function isLogLevel(value: string): value is LogLevel {
  return (levelOrder as string[]).includes(value);
}

export function seriesKeys(
  buckets: HistogramBucket[],
  split: HistogramSplit,
): string[] {
  if (split === "none") {
    return ["events"];
  }
  if (split === "level") {
    return levelOrder.filter((level) =>
      buckets.some((bucket) => seriesValue(bucket, level, split) > 0),
    );
  }
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [key, n] of Object.entries(bucket.series)) {
      totals.set(key, (totals.get(key) ?? 0) + n);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => {
      if (a[0] === "other") {
        return 1;
      }
      if (b[0] === "other") {
        return -1;
      }
      return b[1] - a[1];
    })
    .map(([key]) => key);
}

export function seriesValue(
  bucket: HistogramBucket,
  key: string,
  split: HistogramSplit,
): number {
  if (split === "none") {
    return bucket.n;
  }
  if (split === "level") {
    return bucket.series[key] ?? bucket.by_level[key as LogLevel] ?? 0;
  }
  return bucket.series[key] ?? 0;
}

export function seriesTotal(
  buckets: HistogramBucket[],
  key: string,
  split: HistogramSplit,
): number {
  return buckets.reduce((sum, bucket) => sum + seriesValue(bucket, key, split), 0);
}

export function seriesColor(
  key: string,
  split: HistogramSplit,
  index: number,
): string {
  if (split === "level" && isLogLevel(key)) {
    return levelHex[key];
  }
  if (key === "events") {
    return levelHex.info;
  }
  if (key === "other" || key === "-") {
    return chartOtherDark;
  }
  return chartColor(index);
}
