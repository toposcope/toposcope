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
