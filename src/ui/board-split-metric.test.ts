import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelPlot, panelHead } from "./components/board-view";
import { darkPlotTheme } from "./plot-theme";
import { defaultTimeseries } from "../shared/widgets";
import type { BoardPanel } from "../shared/boards";
import type { PanelData } from "./board-panel-data";

const t = (m: number) => new Date(Date.UTC(2026, 10, 3, 9, m)).toISOString();
const times = [t(0), t(1), t(2)];

/** A hunt panel of host CPU split by host, copied onto a board (Add to board). */
const panel: BoardPanel = {
  id: "u",
  name: "CPU by host",
  q: "",
  view: "histogram",
  widget: {
    ...defaultTimeseries({ id: "b" }),
    metric: "host_cpu_seconds_total",
    metricLabels: { mode: "user" },
    metricSplit: "host",
  },
  fixed: null,
};

/** What `/api/search?…&metric=host_cpu_seconds_total&ml=mode:user&msplit=host` answers: lines in `splits`, none in `buckets`. */
const data: PanelData = {
  histogram: times.map((time) => ({ t: time, n: 0 })),
  agg: {
    expr: "host_cpu_seconds_total",
    source: "metric",
    kind: "counter",
    metric: "host_cpu_seconds_total",
    buckets: [],
    stat: null,
    split: "host",
    splits: [
      { key: "web-1", stat: 3, buckets: times.map((time, i) => ({ t: time, v: 1 + i })) },
      { key: "web-2", stat: 6, buckets: times.map((time, i) => ({ t: time, v: 4 + i })) },
    ],
  },
  total: 3,
  from: t(0),
  to: t(3),
  fetchedAt: 0,
};

describe("a board panel of a metric split by a label", () => {
  test("draws one line per value, in the hunt's split colours, each named at its end", () => {
    const html = renderToStaticMarkup(createElement(PanelPlot, { panel, data, live: false }));
    const strokes = [...html.matchAll(/<polyline[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
    expect(strokes).toEqual([darkPlotTheme.palette[0], darkPlotTheme.palette[1]]);
    expect(html).toContain("web-1");
    expect(html).toContain("web-2");
  });

  test("the head says no one last value for lines that each have their own", () => {
    expect(panelHead(panel, data, false)).toBeNull();
  });
});
