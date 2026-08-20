import { describe, expect, test } from "bun:test";
import { defaultLayout } from "../shared/widgets";
import {
  parseSearchUrl,
  serializeSearchUrl,
  type SearchUrlState,
} from "./search-url";

const sample: SearchUrlState = {
  q: "level:error",
  range: "1h",
  from: "2026-08-14T01:00",
  to: "2026-08-14T02:00",
  live: true,
  saved: "abc",
  view: "search",
  split: "level",
  chart: "stacked",
  logScale: false,
  attrFacets: [],
  cols: [],
  step: null,
  agg: null,
  replaceY: false,
  logs: true,
  widgets: defaultLayout().widgets,
  bind: {},
  boardKeys: null,
};

describe("serializeSearchUrl", () => {
  test("writes q, range, live, saved and omits custom from/to for presets", () => {
    expect(serializeSearchUrl(sample)).toBe(
      "?q=level%3Aerror&range=1h&live=1&saved=abc",
    );
  });

  test("writes ISO from/to for custom range", () => {
    const encoded = serializeSearchUrl({ ...sample, range: "custom", live: false, saved: null });
    expect(encoded.startsWith("?q=level%3Aerror&range=custom&from=")).toBe(true);
    expect(encoded.includes("&to=")).toBe(true);
    expect(encoded.includes("live")).toBe(false);
  });
});

describe("parseSearchUrl", () => {
  test("restores live search", () => {
    const parsed = parseSearchUrl("?q=level:error&range=1h&live=1&saved=abc");
    expect(parsed.q).toBe("level:error");
    expect(parsed.range).toBe("1h");
    expect(parsed.live).toBe(true);
    expect(parsed.saved).toBe("abc");
  });

  test("defaults when empty", () => {
    const parsed = parseSearchUrl("");
    expect(parsed.q).toBe("");
    expect(parsed.range).toBe("1h");
    expect(parsed.live).toBe(false);
    expect(parsed.saved).toBeNull();
    expect(parsed.view).toBe("search");
    expect(parsed.split).toBe("level");
    expect(parsed.chart).toBe("stacked");
    expect(parsed.logScale).toBe(false);
    expect(parsed.attrFacets).toEqual([]);
    expect(parsed.cols).toEqual([]);
    expect(parsed.step).toBeNull();
    expect(parsed.agg).toBeNull();
    expect(parsed.replaceY).toBe(false);
  });

  test("round-trips alerts view", () => {
    const encoded = serializeSearchUrl({ ...sample, view: "alerts", live: false });
    expect(encoded).toContain("view=alerts");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.view).toBe("alerts");
    expect(parsed.q).toBe("level:error");
    expect(parsed.saved).toBe("abc");
  });

  test("round-trips fields view without putting roles in the URL", () => {
    const encoded = serializeSearchUrl({ ...sample, view: "fields", live: false });
    expect(encoded).toContain("view=fields");
    expect(encoded).toContain("range=1h");
    expect(encoded).not.toContain("roles");
    expect(encoded).not.toContain("links");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.view).toBe("fields");
    expect(parsed.q).toBe("level:error");
    expect(parsed.range).toBe("1h");
  });

  test("graph overlay keeps q and writes metric plus ml", () => {
    const widgets = defaultLayout().widgets.map((widget) =>
      widget.id === "a"
        ? {
            ...widget,
            agg: null,
            metric: "cpu_seconds",
            metricLabels: { source: "checkout" },
          }
        : widget,
    );
    const encoded = serializeSearchUrl({
      ...sample,
      q: "level:error",
      live: false,
      saved: null,
      widgets,
    });
    expect(encoded).toContain("q=level%3Aerror");
    expect(encoded).toContain("metric=cpu_seconds");
    expect(encoded).toContain("ml=source%3Acheckout");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.q).toBe("level:error");
    expect(parsed.widgets[0]?.metric).toBe("cpu_seconds");
    expect(parsed.widgets[0]?.metricLabels).toEqual({ source: "checkout" });
  });

  test("search view omits view param", () => {
    expect(serializeSearchUrl(sample).includes("view")).toBe(false);
    expect(parseSearchUrl("?q=level:error&range=1h").view).toBe("search");
  });

  test("unknown range falls back to 1h", () => {
    expect(parseSearchUrl("?range=9y").range).toBe("1h");
    expect(parseSearchUrl("?range=366d").range).toBe("1h");
  });

  test("round-trips 7d range", () => {
    const encoded = serializeSearchUrl({ ...sample, range: "7d", live: false, saved: null });
    expect(encoded).toContain("range=7d");
    expect(parseSearchUrl(encoded).range).toBe("7d");
  });

  test("round-trips 90m relative range without from/to", () => {
    const encoded = serializeSearchUrl({ ...sample, range: "90m", live: false, saved: null });
    expect(encoded).toBe("?q=level%3Aerror&range=90m");
    expect(parseSearchUrl("?range=90m").range).toBe("90m");
  });

  test("round-trips 50ms relative range", () => {
    const encoded = serializeSearchUrl({ ...sample, range: "50ms", live: false, saved: null });
    expect(encoded).toBe("?q=level%3Aerror&range=50ms");
    expect(parseSearchUrl("?range=50ms").range).toBe("50ms");
  });

  test("round-trips 1w and 2w", () => {
    const encoded = serializeSearchUrl({ ...sample, range: "1w", live: false, saved: null });
    expect(encoded).toBe("?q=level%3Aerror&range=1w");
    expect(parseSearchUrl("?range=1w").range).toBe("1w");
    expect(parseSearchUrl("?range=2w").range).toBe("2w");
    expect(parseSearchUrl("?range=8d").range).toBe("8d");
    expect(parseSearchUrl("?range=30d").range).toBe("30d");
    const eightDays = serializeSearchUrl({
      ...sample,
      range: "8d",
      live: false,
      saved: null,
    });
    expect(eightDays).toContain("range=8d");
    expect(parseSearchUrl(eightDays).range).toBe("8d");
  });

  test("round-trips custom range", () => {
    const custom: SearchUrlState = {
      q: "timeout",
      range: "custom",
      from: "2026-08-14T01:00",
      to: "2026-08-14T02:00",
      live: false,
      saved: null,
      view: "search",
      split: "level",
      chart: "stacked",
      logScale: false,
      attrFacets: [],
      cols: [],
      step: null,
      agg: null,
      replaceY: false,
      logs: true,
      widgets: defaultLayout().widgets,
      bind: {},
      boardKeys: null,
    };
    const parsed = parseSearchUrl(serializeSearchUrl(custom));
    expect(parsed.q).toBe("timeout");
    expect(parsed.range).toBe("custom");
    expect(parsed.from).toBe("2026-08-14T01:00:00.000");
    expect(parsed.to).toBe("2026-08-14T02:00:00.000");
  });

  test("round-trips custom range milliseconds", () => {
    const custom: SearchUrlState = {
      ...sample,
      q: "timeout",
      range: "custom",
      from: "2026-08-14T01:00:00.123",
      to: "2026-08-14T01:00:00.135",
      live: false,
      saved: null,
    };
    const parsed = parseSearchUrl(serializeSearchUrl(custom));
    expect(parsed.from).toBe("2026-08-14T01:00:00.123");
    expect(parsed.to).toBe("2026-08-14T01:00:00.135");
  });

  test("board copy-link writes saved plus bind params and omits q", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      q: "level:warn status:4* install_name:acme-eu",
      live: false,
      saved: "s7",
      range: "4h",
      bind: { install_name: "acme-eu" },
      boardKeys: ["install_name"],
    });
    expect(encoded).toBe("?saved=s7&install_name=acme-eu&range=4h");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.saved).toBe("s7");
    expect(parsed.bind.install_name).toBe("acme-eu");
    expect(parsed.q).toBe("");
    expect(parsed.range).toBe("4h");
  });

  test("round-trips histogram split, chart, and log scale", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      split: "service",
      chart: "line",
      logScale: true,
    });
    expect(encoded).toContain("split=service");
    expect(encoded).toContain("chart=line");
    expect(encoded).toContain("scale=log");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.split).toBe("service");
    expect(parsed.chart).toBe("line");
    expect(parsed.logScale).toBe(true);
  });

  test("round-trips histogram bar interval", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      step: "15m",
    });
    expect(encoded).toContain("step=15m");
    expect(parseSearchUrl(encoded).step).toBe("15m");
    expect(serializeSearchUrl(sample).includes("step=")).toBe(false);
  });

  test("round-trips attr facet pins", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      attrFacets: ["path", "user_id"],
    });
    expect(encoded).toContain("af=path%2Cuser_id");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.attrFacets).toEqual(["path", "user_id"]);
    expect(serializeSearchUrl(sample).includes("af=")).toBe(false);
  });

  test("round-trips promoted display columns", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      cols: ["path", "status", "user_id", "duration_ms"],
    });
    expect(encoded).toContain("cols=path%2Cstatus%2Cuser_id");
    expect(encoded).not.toContain("duration_ms");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.cols).toEqual(["path", "status", "user_id"]);
    expect(serializeSearchUrl(sample).includes("cols=")).toBe(false);
    expect(parseSearchUrl("?cols=level,path,PATH").cols).toEqual(["path"]);
  });

  test("round-trips agg overlay and replace-Y", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      agg: "p99:duration_ms",
      replaceY: true,
    });
    expect(encoded).toContain("agg=p99%3Aduration_ms");
    expect(encoded).toContain("y=agg");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.agg).toBe("p99:duration_ms");
    expect(parsed.replaceY).toBe(true);
    expect(serializeSearchUrl(sample).includes("agg=")).toBe(false);
    expect(
      serializeSearchUrl({ ...sample, agg: "rate", replaceY: false }).includes(
        "y=",
      ),
    ).toBe(false);
  });

  test("round-trips area chart", () => {
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      chart: "area",
    });
    expect(encoded).toContain("chart=area");
    expect(parseSearchUrl(encoded).chart).toBe("area");
  });

  test("round-trips logs off and a custom widget grid", () => {
    const widgets = [
      ...sample.widgets,
      {
        id: "b",
        kind: "stat" as const,
        x: 0,
        y: 4,
        w: 4,
        h: 2,
        split: "level" as const,
        chart: "stacked" as const,
        agg: "count",
        replaceY: false,
        logScale: false,
        attr: null,
        pct: false,
        n: 10,
        metric: null,
        metricLabels: {},
      },
    ];
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      logs: false,
      widgets,
    });
    expect(encoded).toContain("logs=0");
    expect(encoded).toContain("w=");
    const parsed = parseSearchUrl(encoded);
    expect(parsed.logs).toBe(false);
    expect(parsed.widgets).toHaveLength(2);
    expect(parsed.widgets[1]?.kind).toBe("stat");
    expect(serializeSearchUrl(sample).includes("logs=")).toBe(false);
    expect(serializeSearchUrl(sample).includes("w=")).toBe(false);
    const tall = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      widgets: [{ ...sample.widgets[0]!, h: 5 }],
    });
    expect(tall).toContain("w=");
  });

  test("round-trips an ingested metric overlay", () => {
    const widgets = [
      {
        ...sample.widgets[0]!,
        metric: "cpu_seconds",
        metricLabels: { service: "api" },
      },
    ];
    const encoded = serializeSearchUrl({
      ...sample,
      live: false,
      saved: null,
      agg: null,
      widgets,
    });
    expect(encoded).toContain("metric=cpu_seconds");
    expect(encoded).toContain("ml=service%3Aapi");
    expect(encoded.includes("agg=")).toBe(false);
    expect(encoded.includes("w=")).toBe(false);
    const parsed = parseSearchUrl(encoded);
    expect(parsed.widgets[0]?.metric).toBe("cpu_seconds");
    expect(parsed.widgets[0]?.metricLabels).toEqual({ service: "api" });
    expect(parsed.agg).toBeNull();
  });

  test("extras-only w= still restores the pinned histogram from split/chart/agg", () => {
    const parsed = parseSearchUrl(
      "?split=none&chart=line&agg=rate&w=b.h.6.0.3.4.status.pct~c.t.0.0.6.4.none.line.rate",
    );
    expect(parsed.widgets.find((w) => w.id === "a")).toMatchObject({
      kind: "timeseries",
      x: 0,
      y: 0,
      w: 12,
      h: 4,
      split: "none",
      chart: "line",
      agg: "rate",
    });
    expect(parsed.split).toBe("none");
    expect(parsed.chart).toBe("line");
    expect(parsed.agg).toBe("rate");
    expect(parsed.widgets.find((w) => w.id === "c")?.y).toBe(4);
  });
});
