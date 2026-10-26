import { describe, expect, test } from "bun:test";
import { fenceLines, panelWords } from "./share-page";
import { namedPanelTag, panelNameFor } from "./share-from-panel";

describe("a share's page (#266, 26k)", () => {
  test("a named panel in words", () => {
    expect(panelWords({ name: "latency-p99", params: { metric: "p99:fleet_latency", split: "host", range: "24h" } })).toBe("p99 fleet_latency · by host · 24h · line");
    expect(panelWords({ name: "errors", params: { agg: "count", split: "level", range: "7d" } })).toBe("count of logs · by level · 7d · line");
    expect(panelWords({ name: "pools", params: { chart: "donut", key: "pool", n: "5", range: "24h" } })).toBe("top 5 pool by rows · 24h · donut");
  });
  test("panel names from titles, unique on the share; the tag names one", () => {
    expect(panelNameFor("Latency p99 · by host", [])).toBe("latency-p99-by-host");
    expect(panelNameFor("errors", ["errors"])).toBe("errors-2");
    expect(namedPanelTag("https://logs.example.com", "latency-p99")).toBe('<script src="https://logs.example.com/embed.js"\n  data-ticket="${ticket}"\n  data-panel="latency-p99"></script>');
  });
  test("the fence in the page's words", () => {
    const lines = fenceLines({
      scope: { metric_names: ["fleet_latency"], metric_labels: "service:agental", logs: "service:agental", split: ["host", "level"] },
      limits: { min_step: "1m", max_range: "7d", max_lookback: "30d", reads_per_minute: 120 },
      embed: { frame_ancestors: ["https://console.agental.io"] },
    });
    expect(lines).toContainEqual(["may split by", "host · level"]);
    expect(lines).toContainEqual(["limits", "1m bars · 7d window · 30d back · 120 reads/min"]);
    expect(lines).toContainEqual(["framed by", "https://console.agental.io"]);
  });
});

import { addablePanels } from "./share-page";
import { defaultTimeseries } from "../shared/widgets";

describe("Add a panel… (#266)", () => {
  const hunt = { id: "h1", name: "Errors on billing", query: "service:billing level:error", range: "1h" };
  test("a saved hunt's own volume chart is a count of its rows, named after the hunt", () => {
    const { options, why } = addablePanels([hunt], null);
    expect(why).toBeNull();
    expect(options.length).toBe(1);
    expect(options[0]!.label).toBe("Errors on billing · count of logs · by level · 1h · line");
    expect(options[0]!.panel).toMatchObject({ name: "Errors on billing", from: "the hunt Errors on billing" });
    // A share with no logs yet takes the hunt's q as its logs.
    expect(options[0]!.logs).toBe("service:billing level:error");
  });
  test("a log panel from another hunt says it counts the share's logs", () => {
    const { options } = addablePanels([hunt], "service:toposcope");
    expect(options[0]!.label).toContain("counts this share's logs (service:toposcope)");
    expect(options[0]!.logs).toBeNull();
  });
  test("a panel of several metrics is offered one metric at a time", () => {
    const widget = { ...defaultTimeseries({ metric: "disk_used", lines: [{ metric: "disk_free", labels: {} }] } as never) };
    const { options } = addablePanels([{ ...hunt, id: "d", name: "Disk", widgets: { logs: false, widgets: [widget] } }], null);
    expect(options.map((o) => o.panel.params.metric)).toEqual(["disk_used", "disk_free"]);
  });
  test("with nothing to add, it says why", () => {
    expect(addablePanels([], null)).toEqual({ options: [], why: "Nothing to add yet: save a hunt, or use Share… on a panel." });
  });
});
