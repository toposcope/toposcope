import { describe, expect, test } from "bun:test";
import { defaultTimeseries, type WidgetDef } from "../shared/widgets";
import type { ShareView } from "./share-cover";
import { likePattern, mergeScope, panelRange, panelRead, panelTag, proposeScope, proposedShareName } from "./share-from-panel";

const metricPanel = (over: Partial<WidgetDef> = {}): WidgetDef =>
  ({ ...defaultTimeseries({ metric: "fleet_cpu_seconds", metricLabels: { service: "agental" } }), id: "b", metricSplit: "host", ...over }) as WidgetDef;
const none = { allLike: false, splitOn: true, narrowOn: false, logsOn: false };

describe("what a panel reads (#236)", () => {
  test("a metric panel, a Top-N, a log count", () => {
    expect(panelRead(metricPanel())).toEqual({
      reads: [{ kind: "metric", name: "fleet_cpu_seconds", ref: "fleet_cpu_seconds", labels: { service: "agental" }, split: "host", chart: "line", title: "fleet_cpu_seconds" }],
    });
    const top = { ...metricPanel(), kind: "hbar", metric: null, attr: null, split: "host", n: 5, topView: "donut" } as WidgetDef;
    expect(panelRead(top)).toEqual({ reads: [{ kind: "top", key: "host", n: 5, donut: true, title: "top 5 by host" }] });
    const logs = { ...defaultTimeseries({}), id: "a", split: "level" } as WidgetDef;
    expect(panelRead(logs)).toMatchObject({ reads: [{ kind: "logs", agg: "count", split: "level" }] });
  });

  test("24f: merged lines and a log value say why, and offer what can be shared", () => {
    const merged = metricPanel({ lines: [{ metric: "fleet_disk_free", labels: {} }] });
    const r = panelRead(merged);
    expect(r).toHaveProperty("why");
    expect("offers" in r && r.offers.map((o) => [o.label, o.reads.length])).toEqual([
      ["Share fleet_cpu_seconds alone", 1],
      ["One panel each", 2],
    ]);
    const p99 = { ...defaultTimeseries({ agg: "p99:duration_ms" }), id: "c" } as WidgetDef;
    const q = panelRead(p99);
    expect("offers" in q && q.offers.map((o) => o.label)).toEqual(["Share it as a count", "Share it as a rate"]);
  });
});

describe("the proposed scope (24b)", () => {
  test("the panel's metric, its labels fixed, its split", () => {
    const reads = (panelRead(metricPanel()) as { reads: never[] }).reads;
    expect(proposeScope(reads, "", none).scope).toEqual({
      metric_names: ["fleet_cpu_seconds"],
      metric_labels: "service:agental",
      logs: null,
      split: ["host"],
      narrow: [],
    });
    expect(proposeScope(reads, "", { ...none, allLike: true, narrowOn: true, logsOn: true }).scope).toMatchObject({
      metric_names: ["fleet_*"],
      logs: "service:agental",
      narrow: ["host"],
    });
    expect(likePattern("http.server.duration")).toBe("http.*");
    expect(likePattern("uptime")).toBeNull();
  });

  test("labels the panels disagree on are not fixed, and said", () => {
    const a = (panelRead(metricPanel()) as { reads: never[] }).reads;
    const b = (panelRead(metricPanel({ metricLabels: { service: "billing" } })) as { reads: never[] }).reads;
    const { scope, dropped } = proposeScope([...a, ...b], "", none);
    expect(scope.metric_labels).toBe("");
    expect(dropped).toEqual(["service"]);
  });

  test("a log panel shares the hunt's q", () => {
    const logs = (panelRead({ ...defaultTimeseries({}), id: "a", split: "host" } as WidgetDef) as { reads: never[] }).reads;
    expect(proposeScope(logs, "service:agental", none).scope).toMatchObject({ logs: "service:agental", split: ["host"] });
  });
});

describe("into an existing share (24e)", () => {
  const share = (scope: Partial<ShareView["scope"]>): ShareView =>
    ({
      name: "agental-console",
      scope: { metric_names: ["fleet_cpu_seconds"], metric_labels: "service:agental", logs: null, split: ["host"], narrow: [], ...scope },
    }) as ShareView;

  test("grows its names and keys, and says what it now also reads", () => {
    const merged = mergeScope(share({}), { metric_names: ["fleet_latency"], metric_labels: "service:agental", logs: null, split: ["host"], narrow: ["host"] });
    expect(merged).toEqual({
      scope: { metric_names: ["fleet_cpu_seconds", "fleet_latency"], metric_labels: "service:agental", logs: null, split: ["host"], narrow: ["host"] },
      added: ["fleet_latency"],
    });
    const covered = mergeScope(share({ metric_names: ["fleet_*"] }), { metric_names: ["fleet_latency"], metric_labels: "", logs: null, split: [], narrow: [] });
    expect("added" in covered && covered.added).toEqual([]);
  });

  test("refuses a panel fixed to other labels", () => {
    expect(mergeScope(share({}), { metric_names: ["x"], metric_labels: "service:billing", logs: null, split: [], narrow: [] })).toHaveProperty("why");
  });
});

describe("the code (24d)", () => {
  test("a tag per panel, with the backend's ticket", () => {
    const read = (panelRead(metricPanel({ metricChart: "stacked" })) as { reads: never[] }).reads[0]!;
    expect(panelTag("https://logs.example.com", read, "24h")).toBe(
      '<script src="https://logs.example.com/embed.js"\n  data-ticket="${ticket}"\n  data-chart="stacked"\n  data-metric="fleet_cpu_seconds"\n  data-split="host"\n  data-range="24h"\n  data-title="fleet_cpu_seconds"></script>',
    );
  });

  test("the range is the Quick chip the panel shows, else its span", () => {
    expect(panelRange(86_400_000)).toBe("24h");
    expect(panelRange(900_000)).toBe("15m");
    expect(panelRange(2 * 86_400_000)).toBe("2d");
  });

  test("a new share is named for its service, and never twice", () => {
    const scope = { metric_names: [], metric_labels: "service:agental", logs: null, split: [], narrow: [] };
    expect(proposedShareName(scope, [])).toBe("agental-console");
    expect(proposedShareName(scope, ["agental-console"])).toBe("agental-console-2");
  });
});
