import { describe, expect, test } from "bun:test";
import {
  addHbar,
  addStat,
  defaultLayout,
  defaultTimeseries,
  patchWidget,
  seriesQueryKey,
  widgetSeriesQuery,
} from "../shared/widgets";
import {
  associativeWindowStat,
  deriveLiveSeries,
  extraQueryLiveFetch,
  isCountOrRateQuery,
  levelFacetValuesFromHistogram,
  mergeIncrementalExtraSeries,
  queryLiveMergeable,
} from "./live-widget-clock";
import type { HistogramBucket } from "./types";
import { parseSearchAgg } from "../query/agg";

function stamp<T extends object>(data: T): T & { fetchedAt: number } {
  return { ...data, fetchedAt: 1 };
}

describe("queryLiveMergeable", () => {
  const volume = widgetSeriesQuery(defaultTimeseries());
  const widgets = defaultLayout().widgets;

  test("core-only q is mergeable", () => {
    expect(queryLiveMergeable(volume, "level:error", [], widgets)).toBe(true);
    expect(queryLiveMergeable(volume, "", [], widgets)).toBe(true);
  });

  test("logs-scan q is never mergeable", () => {
    expect(queryLiveMergeable(volume, "timeout", [], widgets)).toBe(false);
    expect(queryLiveMergeable(volume, "duration_ms:>100", [], widgets)).toBe(
      false,
    );
  });

  test("labeled metric is never mergeable", () => {
    const query = widgetSeriesQuery(
      defaultTimeseries({ metric: "cpu_seconds", metricLabels: { service: "api" } }),
    );
    expect(queryLiveMergeable(query, "", [], widgets)).toBe(false);
  });

  test("unlabeled metric timeseries is mergeable", () => {
    const query = widgetSeriesQuery(
      defaultTimeseries({ metric: "cpu_seconds", metricLabels: {} }),
    );
    expect(queryLiveMergeable(query, "", [], widgets)).toBe(true);
  });

  test("p99 timeseries is mergeable; p99 stat is not; logs-scan p99 is never 2s", () => {
    const spark = defaultTimeseries({ agg: "p99:duration_ms" });
    const query = widgetSeriesQuery(spark);
    expect(queryLiveMergeable(query, "", [], [spark])).toBe(true);
    expect(queryLiveMergeable(query, "", [], [spark], 10_000)).toBe(false);
    expect(queryLiveMergeable(query, "timeout", [], [spark])).toBe(false);
    const withStat = addStat(defaultLayout().widgets);
    const statP99 = patchWidget(withStat, "b", { agg: "p99:duration_ms" });
    expect(
      queryLiveMergeable(widgetSeriesQuery(statP99[1]!), "", [], statP99),
    ).toBe(false);
  });
});

describe("extraQueryLiveFetch", () => {
  test("count stat alone does not fetch", () => {
    const widgets = addStat(defaultLayout().widgets);
    const query = widgetSeriesQuery(widgets[1]!);
    expect(isCountOrRateQuery(query)).toBe(true);
    expect(extraQueryLiveFetch(query, widgets, "", [], "level")).toBe(false);
  });

  test("same-split rate timeseries is a primary projection", () => {
    const extra = defaultTimeseries({
      id: "b",
      split: "level",
      agg: "rate",
      x: 0,
      y: 4,
    });
    const widgets = [...defaultLayout().widgets, extra];
    expect(
      extraQueryLiveFetch(widgetSeriesQuery(extra), widgets, "", [], "level"),
    ).toBe(false);
  });

  test("extra volume timeseries with another split does fetch", () => {
    const extra = defaultTimeseries({
      id: "b",
      split: "service",
      x: 0,
      y: 4,
    });
    const widgets = [...defaultLayout().widgets, extra];
    expect(
      extraQueryLiveFetch(
        widgetSeriesQuery(extra),
        widgets,
        "level:error",
        [],
        "level",
      ),
    ).toBe(true);
    expect(
      extraQueryLiveFetch(
        widgetSeriesQuery(extra),
        widgets,
        "timeout",
        [],
        "level",
      ),
    ).toBe(false);
  });
});

describe("levelFacetValuesFromHistogram", () => {
  test("sums by_level and drops empty", () => {
    const buckets: HistogramBucket[] = [
      {
        t: "a",
        n: 5,
        series: { error: 3, info: 2 },
        by_level: { error: 3, info: 2 },
      },
      {
        t: "b",
        n: 4,
        series: { error: 4 },
        by_level: { error: 4 },
      },
    ];
    expect(levelFacetValuesFromHistogram(buckets)).toEqual([
      { v: "error", n: 7 },
      { v: "info", n: 2 },
    ]);
  });
});

describe("associativeWindowStat", () => {
  test("min max sum from bars; p99 and avg refuse", () => {
    const bars = [{ v: 2 }, { v: 8 }, { v: 4 }];
    expect(associativeWindowStat(parseSearchAgg("min:duration_ms"), bars)).toBe(
      2,
    );
    expect(associativeWindowStat(parseSearchAgg("max:duration_ms"), bars)).toBe(
      8,
    );
    expect(associativeWindowStat(parseSearchAgg("sum:duration_ms"), bars)).toBe(
      14,
    );
    expect(
      associativeWindowStat(parseSearchAgg("p99:duration_ms"), bars),
    ).toBeNull();
    expect(
      associativeWindowStat(parseSearchAgg("avg:duration_ms"), bars),
    ).toBeNull();
  });
});

describe("mergeIncrementalExtraSeries", () => {
  test("merges volume bars and recomputes min from the window", () => {
    const prev = {
      histogram: [
        {
          t: "2026-01-01T00:00:00.000Z",
          n: 4,
          series: { api: 4 },
          by_level: { error: 4 },
        },
      ],
      agg: {
        expr: "min:duration_ms",
        source: "numeric" as const,
        buckets: [{ t: "2026-01-01T00:00:00.000Z", v: 9 }],
        stat: 9,
      },
      total: 4,
    };
    const merged = mergeIncrementalExtraSeries(
      prev,
      {
        histogram: [
          {
            t: "2026-01-01T00:01:00.000Z",
            n: 2,
            series: { api: 2 },
            by_level: { error: 2 },
          },
        ],
        agg: {
          expr: "min:duration_ms",
          source: "numeric",
          buckets: [{ t: "2026-01-01T00:01:00.000Z", v: 3 }],
          stat: 3,
        },
      },
      { split: "service", agg: "min:duration_ms", metric: null, metricLabels: {} },
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
      60_000,
    );
    expect(merged.total).toBe(6);
    expect(merged.agg?.stat).toBe(3);
    expect(merged.agg?.buckets.map((bucket) => bucket.v)).toEqual([9, 3]);
  });

  test("unlabeled metric keeps the previous window stat", () => {
    const prev = {
      histogram: [],
      agg: {
        expr: "cpu_seconds",
        source: "metric" as const,
        buckets: [{ t: "2026-01-01T00:00:00.000Z", v: 1 }],
        stat: 10,
      },
      total: 0,
    };
    const merged = mergeIncrementalExtraSeries(
      prev,
      {
        histogram: [],
        agg: {
          expr: "cpu_seconds",
          source: "metric",
          buckets: [{ t: "2026-01-01T00:01:00.000Z", v: 2 }],
          stat: 2,
        },
      },
      {
        split: "level",
        agg: null,
        metric: "cpu_seconds",
        metricLabels: {},
      },
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
      60_000,
    );
    expect(merged.agg?.stat).toBe(10);
    expect(merged.agg?.buckets).toHaveLength(2);
  });
});

describe("deriveLiveSeries", () => {
  const primary = {
    histogram: [
      {
        t: "a",
        n: 10,
        series: { error: 10 },
        by_level: { error: 10 },
      },
    ] satisfies HistogramBucket[],
    agg: null,
    total: 10,
  };

  test("count and rate stats follow the primary total", () => {
    let widgets = addStat(defaultLayout().widgets);
    widgets = patchWidget(widgets, "b", { agg: "rate" });
    const derived = deriveLiveSeries(
      widgets,
      primary,
      "level",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
      60_000,
      stamp,
    );
    const key = seriesQueryKey(widgetSeriesQuery(widgets[1]!));
    expect(derived[key]?.total).toBe(10);
    expect(derived[key]?.agg?.source).toBe("rate");
  });

  test("level Top-N derives only when the pinned split is level", () => {
    const widgets = addHbar(defaultLayout().widgets);
    const fromLevel = deriveLiveSeries(
      widgets,
      primary,
      "level",
      undefined,
      undefined,
      60_000,
      stamp,
    );
    expect(fromLevel["facet|level"]?.values).toEqual([{ v: "error", n: 10 }]);
    const fromService = deriveLiveSeries(
      widgets,
      primary,
      "service",
      undefined,
      undefined,
      60_000,
      stamp,
    );
    expect(fromService["facet|level"]).toBeUndefined();
  });
});
