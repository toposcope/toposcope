import { describe, expect, test } from "bun:test";
import {
  clampWidget,
  defaultTimeseries,
  formatWidgetsParam,
  parseSavedLayout,
  parseWidgetsParam,
  widgetLineQueries,
  widgetSeriesQueries,
  type WidgetDef,
} from "./widgets";

// #169: agental's "Disk · all boxes" drew sellable, sold and used on three panels with three scales.
const disk = (extra: Partial<WidgetDef> = {}): WidgetDef =>
  defaultTimeseries({
    id: "b",
    w: 6,
    replaceY: true,
    metric: "agental.box.disk.sellable",
    metricLabels: { box: "all" },
    lines: [
      { metric: "agental.box.disk.sold", labels: { box: "all" } },
      { metric: "agental.box.disk.used", labels: { box: "all" } },
    ],
    names: { "0": "Capacity", "1": "Promised", "2": "In use" },
    title: "Disk, all boxes",
    note: "Capacity is what the boxes can sell, Promised what sandboxes were sold, In use what they hold.",
    ...extra,
  });

describe("a panel's merged lines, names, title and note", () => {
  test("they are kept on a metric panel", () => {
    const panel = disk();
    expect(panel.lines).toHaveLength(2);
    expect(panel.names).toEqual({ "0": "Capacity", "1": "Promised", "2": "In use" });
    expect(panel.title).toBe("Disk, all boxes");
    expect(panel.note?.startsWith("Capacity is")).toBe(true);
  });

  test("four lines at most, each once, never the panel's own metric again", () => {
    const panel = disk({
      lines: [
        { metric: "agental.box.disk.sellable", labels: { box: "all" } },
        { metric: "a.one", labels: {} },
        { metric: "a.two", labels: {} },
        { metric: "a.two", labels: {} },
        { metric: "a.three", labels: {} },
        { metric: "a.four", labels: {} },
        { metric: "not a name!", labels: {} },
      ],
    });
    expect(panel.lines?.map((line) => line.metric)).toEqual(["a.one", "a.two", "a.three"]);
  });

  test("a panel merges metrics or splits one, never both", () => {
    const panel = disk({ metricSplit: "basis" });
    expect(panel.metricSplit).toBe("basis");
    expect(panel.lines).toBeUndefined();
  });

  test("names are cut to 24 characters, the title to 80, the note to 160; blank is none", () => {
    const panel = disk({
      names: { "0": "x".repeat(30), "1": "  " },
      title: "t".repeat(90),
      note: "n".repeat(200),
    });
    expect(panel.names).toEqual({ "0": "x".repeat(24) });
    expect(panel.title).toHaveLength(80);
    expect(panel.note).toHaveLength(160);
    expect(clampWidget({ ...panel, title: "   " }).title).toBeUndefined();
  });

  test("a panel with nothing named or noted carries none of the new keys", () => {
    const plain = defaultTimeseries({ id: "b", metric: "agental.box.disk.sold" });
    expect(Object.keys(plain)).not.toContain("lines");
    expect(Object.keys(plain)).not.toContain("names");
    expect(Object.keys(plain)).not.toContain("title");
    expect(Object.keys(plain)).not.toContain("note");
  });

  test("a log panel keeps no merged lines", () => {
    const logs = defaultTimeseries({ id: "b", lines: [{ metric: "a.one", labels: {} }] });
    expect(logs.lines).toBeUndefined();
  });
});

describe("the URL keeps them", () => {
  test("a merged, named, titled, noted panel round-trips, dots and tildes in its words included", () => {
    const panel = disk({ note: "Room to sell: Capacity − Promised. ~ is fine." });
    const pinned = defaultTimeseries();
    const back = parseWidgetsParam(formatWidgetsParam([pinned, panel]));
    const again = back.find((w) => w.id === "b")!;
    expect(again.lines).toEqual(panel.lines);
    expect(again.names).toEqual(panel.names);
    expect(again.title).toBe(panel.title);
    expect(again.note).toBe("Room to sell: Capacity − Promised. ~ is fine.");
    expect(again.metric).toBe("agental.box.disk.sellable");
    expect(again.metricLabels).toEqual({ box: "all" });
    expect(again.replaceY).toBe(true);
  });

  test("a histogram reading as the merged metric survives", () => {
    const panel = disk({ metric: "p99:http.server.duration", metricLabels: {}, lines: [{ metric: "p50:http.server.duration", labels: {} }] });
    const again = parseWidgetsParam(formatWidgetsParam([defaultTimeseries(), panel])).find((w) => w.id === "b")!;
    expect(again.metric).toBe("p99:http.server.duration");
    expect(again.lines).toEqual([{ metric: "p50:http.server.duration", labels: {} }]);
  });
});

describe("a saved search's JSON sets them", () => {
  test("lines, names, title and note come in through the JSON a script posts", () => {
    const layout = parseSavedLayout({
      logs: false,
      widgets: [
        {
          id: "a",
          kind: "timeseries",
          x: 0,
          y: 0,
          w: 12,
          h: 4,
          replaceY: true,
          metric: "agental.box.disk.sellable",
          metricLabels: { box: "all" },
          lines: [{ metric: "agental.box.disk.sold", labels: { box: "all" } }],
          names: { "0": "Capacity", "1": "Promised" },
          title: "Disk, all boxes",
          note: "What is promised against what can be sold.",
        },
      ],
    });
    const panel = layout!.widgets[0]!;
    expect(panel.lines).toEqual([{ metric: "agental.box.disk.sold", labels: { box: "all" } }]);
    expect(panel.names).toEqual({ "0": "Capacity", "1": "Promised" });
    expect(panel.title).toBe("Disk, all boxes");
  });
});

describe("each line is read on its own", () => {
  test("one query a line, the panel's own first", () => {
    const queries = widgetLineQueries(disk());
    expect(queries.map((q) => q.metric)).toEqual([
      "agental.box.disk.sellable",
      "agental.box.disk.sold",
      "agental.box.disk.used",
    ]);
    expect(queries.every((q) => q.metricLabels.box === "all")).toBe(true);
  });

  test("the canvas fetches every merged line", () => {
    const queries = widgetSeriesQueries([defaultTimeseries(), disk()]);
    expect(queries.map((q) => q.metric)).toContain("agental.box.disk.used");
  });
});
