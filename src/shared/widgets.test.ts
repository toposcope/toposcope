import { describe, expect, test } from "bun:test";
import {
  addHbar,
  addHistogram,
  addStat,
  clampHbarN,
  defaultLayout,
  defaultTimeseries,
  duplicateWidget,
  formatSavedLayout,
  formatSharePct,
  formatWidgetsParam,
  hbarRows,
  hbarRowIsValue,
  isDefaultLayout,
  isSingleHistogram,
  maxWidgets,
  moveWidget,
  parseSavedLayout,
  parseWidgetsParam,
  patchWidget,
  placeWidget,
  removeWidget,
  resizeWidget,
  widgetAttrKeys,
  widgetHbarFetch,
  hbarFetchNeedsNetwork,
  pickerAttrKeys,
  widgetSeriesQueries,
  extraHeadCollapsed,
  extraHeadCollapsePx,
  extraOverflowAfterPick,
  widgetTitle,
} from "./widgets";

describe("widget URL tokens", () => {
  test("omits as default layout", () => {
    const layout = defaultLayout();
    expect(isDefaultLayout(layout)).toBe(true);
    expect(formatSavedLayout(layout)).toBeNull();
  });

  test("round-trips a custom grid", () => {
    let widgets = defaultLayout().widgets;
    widgets = addStat(widgets);
    widgets = addHbar(widgets);
    const encoded = formatWidgetsParam(widgets);
    expect(encoded).toContain(".s.");
    expect(encoded).toContain(".h.");
    const parsed = parseWidgetsParam(encoded);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((w) => w.kind)).toEqual(["timeseries", "stat", "hbar"]);
    expect(formatWidgetsParam(parsed)).toBe(encoded);
  });

  test("round-trips a metric overlay", () => {
    const encoded = "a.t.0.0.12.4.level.stacked.m:cpu_seconds.l:service:api.y";
    const [widget] = parseWidgetsParam(encoded);
    expect(widget).toMatchObject({
      metric: "cpu_seconds",
      metricLabels: { service: "api" },
      replaceY: true,
      agg: null,
    });
    expect(formatWidgetsParam([widget!])).toBe(encoded);
    const dotted = "a.t.0.0.12.4.level.line.m:http.server.duration";
    expect(parseWidgetsParam(dotted)[0]?.metric).toBe("http.server.duration");
    expect(formatWidgetsParam(parseWidgetsParam(dotted))).toBe(dotted);
    const stat = "b.s.0.4.4.2.m:cpu_seconds";
    expect(parseWidgetsParam(stat).find((w) => w.id === "b")).toMatchObject({
      kind: "stat",
      metric: "cpu_seconds",
      agg: null,
    });
  });

  test("round-trips p99 overlay flags", () => {
    const encoded = "a.t.0.0.12.4.service.area.p99:duration_ms.yz";
    const [widget] = parseWidgetsParam(encoded);
    expect(widget).toMatchObject({
      id: "a",
      kind: "timeseries",
      split: "service",
      chart: "area",
      agg: "p99:duration_ms",
      replaceY: true,
      logScale: true,
    });
    expect(formatWidgetsParam([widget!])).toBe(encoded);
  });

  test("round-trips an attr top-N group", () => {
    const encoded = "b.h.0.4.12.3.status";
    const hbar = parseWidgetsParam(encoded).find((w) => w.id === "b");
    expect(hbar).toMatchObject({
      id: "b",
      kind: "hbar",
      attr: "status",
    });
    expect(formatWidgetsParam([hbar!])).toBe(encoded);
    const dotted = "c.h.0.4.8.3.http.status_code";
    expect(parseWidgetsParam(dotted).find((w) => w.id === "c")?.attr).toBe(
      "http.status_code",
    );
    expect(
      formatWidgetsParam(parseWidgetsParam(dotted).filter((w) => w.id === "c")),
    ).toBe(dotted);
    const withPct = "b.h.0.4.12.3.status.pct";
    expect(parseWidgetsParam(withPct).find((w) => w.id === "b")).toMatchObject({
      attr: "status",
      pct: true,
    });
    expect(
      formatWidgetsParam(parseWidgetsParam(withPct).filter((w) => w.id === "b")),
    ).toBe(withPct);
    const levelPct = "b.h.0.4.12.3.pct";
    expect(parseWidgetsParam(levelPct).find((w) => w.id === "b")).toMatchObject({
      attr: null,
      split: "level",
      pct: true,
    });
    expect(
      formatWidgetsParam(parseWidgetsParam(levelPct).filter((w) => w.id === "b")),
    ).toBe(levelPct);
    const servicePct = "b.h.0.4.12.3.service.pct";
    expect(parseWidgetsParam(servicePct).find((w) => w.id === "b")).toMatchObject({
      attr: null,
      split: "service",
      pct: true,
    });
    expect(
      formatWidgetsParam(
        parseWidgetsParam(servicePct).filter((w) => w.id === "b"),
      ),
    ).toBe(servicePct);
    const withN = "b.h.0.4.12.3.status.n20";
    expect(parseWidgetsParam(withN).find((w) => w.id === "b")).toMatchObject({
      attr: "status",
      n: 20,
      pct: false,
    });
    expect(
      formatWidgetsParam(parseWidgetsParam(withN).filter((w) => w.id === "b")),
    ).toBe(withN);
    const nAndPct = "b.h.0.4.12.3.n5.pct";
    expect(parseWidgetsParam(nAndPct).find((w) => w.id === "b")).toMatchObject({
      attr: null,
      split: "level",
      n: 5,
      pct: true,
    });
    expect(
      formatWidgetsParam(parseWidgetsParam(nAndPct).filter((w) => w.id === "b")),
    ).toBe(nAndPct);
    expect(parseWidgetsParam("b.h.0.4.12.3.status").find((w) => w.id === "b")?.n).toBe(
      10,
    );
  });

  test("extras-only w= still gets the pinned histogram", () => {
    const widgets = parseWidgetsParam(
      "b.h.6.0.3.4.status.pct~c.t.0.0.6.4.none.line.rate",
      { split: "none", chart: "line", agg: "rate" },
    );
    expect(widgets.find((w) => w.id === "a")).toMatchObject({
      id: "a",
      kind: "timeseries",
      x: 0,
      y: 0,
      w: 12,
      h: 4,
      split: "none",
      chart: "line",
      agg: "rate",
    });
    expect(widgets.find((w) => w.id === "c")).toMatchObject({
      kind: "timeseries",
      y: 4,
      split: "none",
      chart: "line",
      agg: "rate",
    });
    expect(widgets.find((w) => w.id === "b")).toMatchObject({
      kind: "hbar",
      attr: "status",
      pct: true,
      y: 4,
    });
  });

  test("caps at 6 and keeps the selected extras", () => {
    let widgets = defaultLayout().widgets;
    for (let i = 0; i < 10; i++) {
      widgets = addStat(widgets);
    }
    expect(widgets).toHaveLength(maxWidgets);
  });
});

describe("place / move / resize", () => {
  test("extra histogram is 6×4 beside or below the pinned plot", () => {
    const widgets = addHistogram(defaultLayout().widgets);
    expect(widgets[1]).toMatchObject({ kind: "timeseries", w: 6, h: 4 });
    expect(widgets[0]).toMatchObject({ id: "a", x: 0, y: 0 });
    expect(widgets[1]?.y).toBeGreaterThanOrEqual(4);
  });

  test("move snaps out of overlap", () => {
    let widgets = addStat(defaultLayout().widgets);
    const id = widgets[1]?.id;
    expect(id).toBeTruthy();
    widgets = moveWidget(widgets, id!, 0, 0);
    expect(widgets.find((w) => w.id === id)?.y).toBeGreaterThanOrEqual(4);
  });

  test("resize keeps min width and grid", () => {
    const widgets = resizeWidget(defaultLayout().widgets, "a", 99, 1);
    expect(widgets[0]).toMatchObject({ w: 12, h: 3, x: 0 });
  });

  test("stat resizes down to 1×2", () => {
    let widgets = addStat(defaultLayout().widgets);
    const id = widgets[1]?.id;
    expect(id).toBeTruthy();
    widgets = resizeWidget(widgets, id!, 1, 1);
    expect(widgets.find((item) => item.id === id)).toMatchObject({
      w: 1,
      h: 2,
    });
  });

  test("cannot move the pinned histogram", () => {
    const widgets = defaultLayout().widgets;
    expect(moveWidget(widgets, "a", 3, 2)).toEqual(widgets);
  });

  test("extras tile beside a narrowed histogram", () => {
    let widgets = resizeWidget(defaultLayout().widgets, "a", 6, 4);
    widgets = addStat(widgets);
    expect(widgets[0]).toMatchObject({ id: "a", x: 0, y: 0, w: 6, h: 4 });
    expect(widgets[1]).toMatchObject({ kind: "stat", x: 6, y: 0 });
  });

  test("cannot remove the pinned histogram", () => {
    const widgets = removeWidget(addStat(defaultLayout().widgets), "a");
    expect(widgets.some((item) => item.id === "a")).toBe(true);
    expect(widgets).toHaveLength(2);
  });

  test("remove keeps extras at zero", () => {
    const widgets = removeWidget(addStat(defaultLayout().widgets), "b");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.id).toBe("a");
  });

  test("remove keeps the last widget", () => {
    const widgets = defaultLayout().widgets;
    expect(removeWidget(widgets, "a")).toEqual(widgets);
  });

  test("single default histogram omits w= from the URL", () => {
    expect(isSingleHistogram(defaultLayout().widgets)).toBe(true);
    expect(isSingleHistogram(addStat(defaultLayout().widgets))).toBe(false);
    expect(isSingleHistogram(resizeWidget(defaultLayout().widgets, "a", 12, 5))).toBe(
      false,
    );
  });

  test("duplicate lands beside then under, never copies the pinned plot", () => {
    let widgets = addStat(defaultLayout().widgets);
    const stat = widgets[1];
    expect(stat).toBeTruthy();
    widgets = duplicateWidget(widgets, stat!.id);
    expect(widgets).toHaveLength(3);
    const copy = widgets[2];
    expect(copy).toMatchObject({ kind: "stat", w: stat!.w, h: stat!.h });
    expect(copy?.id).not.toBe(stat!.id);
    expect(duplicateWidget(widgets, "a")).toEqual(widgets);
    for (let i = 0; i < 10; i++) {
      widgets = duplicateWidget(widgets, stat!.id);
    }
    expect(widgets).toHaveLength(maxWidgets);
  });
});

describe("extra head", () => {
  test("collapses Duplicate / Copy / Export when the head is too narrow for the icons", () => {
    expect(extraHeadCollapsed(extraHeadCollapsePx)).toBe(true);
    expect(extraHeadCollapsed(extraHeadCollapsePx + 1)).toBe(false);
  });

  test("Copy… and Export… stay on the overflow menu; Duplicate and a format close it", () => {
    expect(extraOverflowAfterPick("copy")).toBe("copy");
    expect(extraOverflowAfterPick("export")).toBe("export");
    expect(extraOverflowAfterPick("duplicate")).toBeNull();
    expect(extraOverflowAfterPick("format")).toBeNull();
  });
});

describe("titles", () => {
  test("names the series the mock draws in the extra-panel head", () => {
    expect(widgetTitle(defaultTimeseries())).toBe("Count");
    expect(widgetTitle(defaultTimeseries({ split: "service" }))).toBe(
      "Count · service",
    );
    expect(widgetTitle(defaultTimeseries({ agg: "p99:duration_ms" }))).toBe(
      "p99(duration_ms)",
    );
    expect(widgetTitle(defaultTimeseries({ agg: "rate" }))).toBe("rate");
    const stat = addStat(defaultLayout().widgets)[1];
    expect(stat && widgetTitle(stat)).toBe("Count");
    const hbar = patchWidget(addHbar(defaultLayout().widgets), "b", {
      attr: "status",
    })[1];
    expect(hbar && widgetTitle(hbar)).toBe("Top-N status");
  });
});

describe("series queries", () => {
  test("dedupes volume + count and keeps a distinct agg", () => {
    let widgets = addStat(defaultLayout().widgets);
    widgets = placeWidget(widgets, {
      kind: "timeseries",
      w: 12,
      h: 4,
      split: "level",
      chart: "line",
      agg: "rate",
      replaceY: false,
      logScale: false,
      attr: null,
      pct: false,
      n: 10,
      metric: null,
      metricLabels: {},
    });
    expect(widgetSeriesQueries(widgets)).toEqual([
      { split: "level", agg: null, metric: null, metricLabels: {} },
      { split: "level", agg: "rate", metric: null, metricLabels: {} },
    ]);
  });

  test("attr top-N is not a histogram split query", () => {
    const widgets = patchWidget(addHbar(defaultLayout().widgets), "b", {
      attr: "status",
    });
    expect(widgetAttrKeys(widgets)).toEqual(["status"]);
    expect(widgetSeriesQueries(widgets)).toEqual([
      { split: "level", agg: null, metric: null, metricLabels: {} },
    ]);
    expect(widgetHbarFetch(widgets)).toMatchObject({
      attrKeys: ["status"],
      attrLimit: 10,
      coreLimit: null,
    });
  });

  test("core top-N uses facets not a histogram split", () => {
    const widgets = addHbar(defaultLayout().widgets);
    expect(widgetSeriesQueries(widgets)).toEqual([
      { split: "level", agg: null, metric: null, metricLabels: {} },
    ]);
    expect(widgetHbarFetch(widgets).coreLimit).toBe(10);
    expect(
      widgetHbarFetch(patchWidget(widgets, "b", { n: 20 })).coreLimit,
    ).toBe(20);
  });

  test("N down does not need a facet refetch", () => {
    const base = addHbar(defaultLayout().widgets);
    const high = widgetHbarFetch(patchWidget(base, "b", { n: 20 }));
    const low = widgetHbarFetch(patchWidget(base, "b", { n: 5 }));
    expect(hbarFetchNeedsNetwork(high, low)).toBe(false);
    expect(hbarFetchNeedsNetwork(low, high)).toBe(true);
  });
});

describe("saved layout JSON", () => {
  test("round-trips a saved metric source", () => {
    const widgets = patchWidget(defaultLayout().widgets, "a", {
      metric: "cpu_seconds",
      metricLabels: { service: "api" },
    });
    const layout = { logs: true, widgets };
    expect(parseSavedLayout(formatSavedLayout(layout))).toEqual(layout);
  });

  test("round-trips logs off", () => {
    const layout = { logs: false, widgets: defaultLayout().widgets };
    const raw = formatSavedLayout(layout);
    expect(raw).toBeTruthy();
    expect(parseSavedLayout(raw)).toEqual(layout);
  });

  test("empty / junk is null so callers keep the default", () => {
    expect(parseSavedLayout(null)).toBeNull();
    expect(parseSavedLayout("")).toBeNull();
    expect(parseSavedLayout("nope")).toBeNull();
  });

  test("saved extras without a still get the pinned plot", () => {
    const layout = parseSavedLayout({
      logs: true,
      widgets: [
        {
          id: "b",
          kind: "hbar",
          x: 0,
          y: 0,
          w: 6,
          h: 3,
          attr: "status",
          pct: true,
        },
      ],
    });
    expect(layout?.widgets.find((w) => w.id === "a")).toMatchObject({
      kind: "timeseries",
      x: 0,
      y: 0,
    });
    expect(layout?.widgets.find((w) => w.id === "b")).toMatchObject({
      kind: "hbar",
      attr: "status",
      y: 4,
    });
  });

  test("round-trips top-N pct and N", () => {
    const widgets = patchWidget(addHbar(defaultLayout().widgets), "b", {
      pct: true,
      n: 20,
    });
    const layout = { logs: true, widgets };
    expect(parseSavedLayout(formatSavedLayout(layout))).toEqual(layout);
  });
});

describe("top-N share labels", () => {
  test("formats percent of the widget total", () => {
    expect(formatSharePct(12, 100)).toBe("12%");
    expect(formatSharePct(9.95, 100)).toBe("10%");
    expect(formatSharePct(1.24, 100)).toBe("1.2%");
    expect(formatSharePct(0.05, 100)).toBe("0.1%");
    expect(formatSharePct(0.04, 100)).toBe("<0.1%");
    expect(formatSharePct(10, 0)).toBe("0%");
  });

  test("clamps N and keeps an other remainder", () => {
    expect(clampHbarN(0)).toBe(1);
    expect(clampHbarN(99)).toBe(50);
    expect(clampHbarN(undefined)).toBe(10);
    expect(
      hbarRows(
        [
          { v: "a", n: 80 },
          { v: "b", n: 15 },
          { v: "c", n: 5 },
        ],
        2,
        100,
      ),
    ).toEqual([
      { key: "a", n: 80 },
      { key: "b", n: 15 },
      { key: "other", n: 5 },
    ]);
    expect(hbarRows([{ v: "a", n: 100 }], 10, 100)).toEqual([
      { key: "a", n: 100 },
    ]);
    expect(hbarRows([{ v: "a", n: 90 }], 10, 100)).toEqual([
      { key: "a", n: 90 },
      { key: "-", n: 10 },
    ]);
    expect(
      hbarRows(
        [
          { v: "a", n: 80 },
          { v: "b", n: 10 },
        ],
        2,
        100,
      ),
    ).toEqual([
      { key: "a", n: 80 },
      { key: "b", n: 10 },
      { key: "other", n: 10 },
    ]);
  });

  test("a complete Top-N still paints events that never had the field", () => {
    const status = [
      { v: "500", n: 430 },
      { v: "502", n: 313 },
      { v: "503", n: 249 },
    ];
    const hunt = 1045;
    expect(hbarRows(status, 5, hunt)).toEqual([
      { key: "500", n: 430 },
      { key: "502", n: 313 },
      { key: "503", n: 249 },
      { key: "-", n: 53 },
    ]);
    expect(hbarRows(status, 2, hunt)).toEqual([
      { key: "500", n: 430 },
      { key: "502", n: 313 },
      { key: "other", n: 302 },
    ]);
    expect(hbarRowIsValue("-")).toBe(false);
    expect(hbarRowIsValue("other")).toBe(false);
    expect(hbarRowIsValue("500")).toBe(true);
  });
});

describe("pickerAttrKeys", () => {
  test("keeps the current key and omits lookup/ignore", () => {
    expect(
      pickerAttrKeys(["status", "request_id", "path"], "request_id", [
        "request_id",
        "user_id",
      ]),
    ).toEqual(["request_id", "status", "path"]);
  });
});
