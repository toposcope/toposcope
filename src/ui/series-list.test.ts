import { describe, expect, test } from "bun:test";
import {
  buildSeriesList,
  metricReading,
  metricView,
  midCut,
  readingMenu,
  readingWords,
  splitHit,
  statWords,
  type MetricEntry,
} from "./series-list";

describe("midCut", () => {
  test("a name that fits is whole", () => {
    expect(midCut("http.server.request.duration", 29)).toBe("http.server.request.duration");
  });

  test("a long name keeps its first segment and as much of its end as fits", () => {
    expect(midCut("process.runtime.jvm.memory.usage_after_last_gc", 29)).toBe("process…usage_after_last_gc");
    expect(midCut("http.server.request.duration", 18)).toBe("http…duration");
    expect(midCut("http.server.request.duration", 22)).toBe("http.server…duration");
  });

  test("the end is what tells two names apart, and it survives", () => {
    expect(midCut("http.server.request.duration", 14)).not.toBe(midCut("http.server.request.body.size", 14));
    expect(midCut("http.server.request.duration", 14).endsWith("duration")).toBe(true);
  });

  test("when even first…last does not fit, the end is kept", () => {
    expect(midCut("process.runtime.jvm.memory.usage_after_last_gc", 12)).toBe("…ter_last_gc");
  });

  test("a name with no dots is cut at its end", () => {
    expect(midCut("averyveryverylongname", 8)).toBe("averyve…");
  });
});

describe("splitHit", () => {
  test("finds the match in the middle of a name, in any case", () => {
    expect(splitHit("http.server.request.duration", "Request")).toEqual(["http.server.", "request", ".duration"]);
    expect(splitHit("duration_ms", "duration")).toEqual(["", "duration", "_ms"]);
  });

  test("leaves the name whole when there is no match or nothing typed", () => {
    expect(splitHit("cpu", "mem")).toEqual(["cpu", "", ""]);
    expect(splitHit("cpu", "")).toEqual(["cpu", "", ""]);
  });
});

describe("a reading", () => {
  test("a gauge prints avg; a counter prints its sum with the bar width", () => {
    expect(metricReading("gauge", "1m")).toBe("avg");
    expect(metricReading("counter", "1m")).toBe("sum / 1m");
    expect(metricReading("counter", "5m", true)).toBe("sum/5m");
  });

  test("in words, a counter's bar is never a level", () => {
    expect(readingWords("counter", "1m")).toBe("counter · arrived in this 1m — not a level");
    expect(readingWords("gauge", "1m")).toBe("gauge · average level in this 1m");
    expect(statWords("counter", "1h")).toBe("sum over the last 1h · counter");
    expect(statWords("gauge", "")).toBe("avg level over this window · gauge");
  });
});

const names: Array<[string, MetricEntry["kind"]]> = [
  ["http.server.request.duration.count", "counter"],
  ["http.server.active_requests", "gauge"],
  ["app.jobs.processed", "counter"],
  ["process.cpu.utilization", "gauge"],
  ["http.client.request.duration.count", "counter"],
  ["db.client.connection.count", "gauge"],
  ["process.memory.usage", "gauge"],
  ["http.server.request.body.size.count", "counter"],
  ["rpc.server.duration.count", "counter"],
  ["db.client.operation.duration.count", "counter"],
  ["system.cpu.utilization", "gauge"],
  ["process.runtime.jvm.memory.usage_after_last_gc", "gauge"],
];
const metrics: MetricEntry[] = names.map(([name, kind], i) => ({ name, kind, points: 1000 - i }));
const fields = ["duration_ms", "status", "bytes_out", "upstream_ms", "queue_ms", "retries", "attempt", "size_kb", "ninth_field"];
const base = { card: false, pick: { kind: "off" } as const, agg: null, numericKeys: fields, metrics, metricTotal: 64, filter: "", window: "1h" };

describe("the list with nothing typed", () => {
  const list = buildSeriesList(base);

  test("Off and Rate first, then log fields, then the eight busiest metrics", () => {
    expect(list.sections.map((section) => section.id)).toEqual(["base", "fields", "metrics"]);
    expect(list.sections[0]!.rows.map((row) => [row.name, row.on])).toEqual([["Off", true], ["Rate", false]]);
    expect(list.sections[1]!.rows).toHaveLength(8);
    expect(list.sections[1]!.rows[0]!.name).toBe("duration_ms");
    expect(list.sections[2]!.rows.map((row) => row.name)).toEqual(names.slice(0, 8).map(([name]) => name));
  });

  test("each row says what it is in a word", () => {
    expect(list.sections[1]!.rows[0]!.tag).toBe("field");
    expect(list.sections[2]!.rows.slice(0, 3).map((row) => row.tag)).toEqual(["counter", "gauge", "counter"]);
  });

  test("the heads say how many, and the last line says how many more and how to reach them", () => {
    expect(list.sections[1]!.meta).toBe("8");
    expect(list.sections[2]!.meta).toBe("busiest 8 of 64 · 1h");
    expect(list.more).toBe("56 more metrics have points in the last 1h — type any part of a name to find one.");
    expect(list.matches).toBe(0);
  });

  test("a card says Count where the pinned plot says Off", () => {
    expect(buildSeriesList({ ...base, card: true }).sections[0]!.rows[0]!.name).toBe("Count");
  });

  test("a custom window is called this window", () => {
    const custom = buildSeriesList({ ...base, window: "" });
    expect(custom.sections[2]!.meta).toBe("busiest 8 of 64");
    expect(custom.more).toContain("in this window");
  });
});

describe("the list while typing", () => {
  test("a match in the middle of a name is found, in fields and in metrics", () => {
    const list = buildSeriesList({ ...base, filter: "duration" });
    expect(list.sections.map((section) => section.id)).toEqual(["fields", "metrics"]);
    expect(list.sections[0]!.rows.map((row) => row.name)).toEqual(["duration_ms"]);
    expect(list.sections[0]!.meta).toBe("1 of 9");
    expect(list.sections[1]!.rows.map((row) => row.name)).toEqual([
      "http.server.request.duration.count",
      "http.client.request.duration.count",
      "rpc.server.duration.count",
      "db.client.operation.duration.count",
    ]);
    expect(list.sections[1]!.meta).toBe("4 of 64 with points · 1h");
    expect(list.matches).toBe(5);
    expect(list.more).toBe("");
  });

  test("a ninth numeric log field is found by typing", () => {
    expect(buildSeriesList(base).sections[1]!.rows.map((row) => row.name)).not.toContain("ninth_field");
    const list = buildSeriesList({ ...base, filter: "ninth" });
    expect(list.sections[0]!.rows.map((row) => row.value)).toEqual(["k:ninth_field"]);
  });

  test("a metric past the eight busiest is found by typing", () => {
    const list = buildSeriesList({ ...base, filter: "last_gc" });
    expect(list.sections.at(-1)!.rows.map((row) => row.value)).toEqual(["m:process.runtime.jvm.memory.usage_after_last_gc"]);
  });

  test("Off and Rate step aside while they do not match", () => {
    expect(buildSeriesList({ ...base, filter: "rat" }).sections[0]!.rows.map((row) => row.name)).toEqual(["Rate"]);
  });

  test("no match is said in words, about this window", () => {
    const list = buildSeriesList({ ...base, filter: "duraton" });
    expect(list.sections).toEqual([]);
    expect(list.emptyTitle).toBe("Nothing named like “duraton” has points in the last 1h.");
    expect(list.emptyBody).toContain("only while it has points in this window");
  });
});

describe("a picked metric", () => {
  const pick = { kind: "metric", name: "process.cpu.utilization" } as const;

  test("is listed once, under Picked, and not again among the metrics", () => {
    const list = buildSeriesList({ ...base, pick, picked: metrics[3]! });
    expect(list.sections[0]).toMatchObject({ id: "picked", meta: "stays here while picked" });
    expect(list.sections[0]!.rows[0]).toMatchObject({ name: "process.cpu.utilization", tag: "gauge", on: true });
    const listed = list.sections.flatMap((section) => section.rows.map((row) => row.name));
    expect(listed.filter((name) => name === "process.cpu.utilization")).toHaveLength(1);
    expect(list.sections.at(-1)!.rows).toHaveLength(8);
    expect(list.more.startsWith("55 more")).toBe(true);
  });

  test("stays listed when what is typed does not match it", () => {
    const list = buildSeriesList({ ...base, pick, picked: metrics[3]!, filter: "jobs" });
    expect(list.sections.map((section) => section.id)).toEqual(["picked", "metrics"]);
  });

  test("with no points in the window it stays picked and says so", () => {
    const quiet = { kind: "metric", name: "app.refunds.issued" } as const;
    const list = buildSeriesList({ ...base, pick: quiet, picked: { name: "app.refunds.issued", kind: "counter", points: 0 } });
    expect(list.sections[0]!.rows[0]).toMatchObject({ tag: "no points · counter", amber: true, on: true });
    expect(list.sections[0]!.meta).toBe("");
  });

  test("a picked log field outside the busiest eight stays listed", () => {
    const list = buildSeriesList({ ...base, pick: { kind: "key", key: "ninth_field", op: "p99" }, agg: "p99:ninth_field" });
    expect(list.sections[1]!.rows.find((row) => row.on)?.name).toBe("ninth_field");
  });
});

describe("a histogram", () => {
  const latency: MetricEntry = { name: "http.server.request.duration", kind: "histogram", points: 900 };

  test("is listed as one name of its own kind, and picking it starts at its p99", () => {
    const list = buildSeriesList({ ...base, metrics: [latency, ...metrics] });
    const row = list.sections.at(-1)!.rows[0]!;
    expect(row).toMatchObject({ name: "http.server.request.duration", tag: "histogram" });
    expect(row.value).toBe("m:p99:http.server.request.duration");
  });

  test("its reading is the one chosen, with no bar width: p99 is not an amount", () => {
    expect(metricReading("histogram", "1m", false, "p90")).toBe("p90");
    expect(metricReading("histogram", "1m", true, "count")).toBe("count");
    expect(metricReading("histogram", "1m")).toBe("p99");
  });

  test("the menu offers count, sum, avg and three percentiles, each in words", () => {
    expect(readingMenu.map((row) => row.reading)).toEqual(["count", "sum", "avg", "p50", "p90", "p99"]);
    expect(readingMenu.find((row) => row.reading === "p50")!.words).toBe("median");
    expect(readingMenu.find((row) => row.reading === "count")!.words).toBe("how many were observed");
  });

  test("in words, the reading comes with what it is of", () => {
    expect(readingWords("histogram", "1m", "p99")).toBe("histogram · 99th percentile of this 1m");
    expect(readingWords("histogram", "5m", "count")).toBe("histogram · observed in this 5m");
    expect(statWords("histogram", "1h", "p99")).toBe("p99 of every observation in the last 1h · histogram");
    expect(statWords("histogram", "1h", "avg")).toBe("mean of every observation in the last 1h · histogram");
    expect(statWords("histogram", "", "count")).toBe("observations in this window · histogram");
  });

  test("is shown by what its series says, then the window's list, then the link", () => {
    const pick = { name: "http.server.request.duration", reading: "p50" as const };
    expect(metricView(pick, latency)).toEqual({ name: pick.name, kind: "histogram", reading: "p50" });
    expect(metricView({ name: pick.name }, latency)).toEqual({ name: pick.name, kind: "histogram", reading: "p99" });
    expect(metricView(pick, null, { kind: "histogram", reading: "p90", metric: pick.name }).reading).toBe("p90");
    // A reading in front of a gauge's name means nothing.
    expect(metricView({ name: "process.memory.usage", reading: "p50" }, metrics[6]!)).toEqual({
      name: "process.memory.usage",
      kind: "gauge",
      reading: null,
    });
  });

  test("an older link's `.count` is shown, and listed, as the count of the histogram", () => {
    const pick = { kind: "metric", name: "http.server.request.duration.count" } as const;
    const entry: MetricEntry = { name: pick.name, kind: "histogram", points: 900, of: latency.name, reading: "count" };
    expect(metricView(pick, entry)).toEqual({ name: latency.name, kind: "histogram", reading: "count" });
    const list = buildSeriesList({ ...base, pick, picked: entry, metrics: [latency, ...metrics] });
    expect(list.sections[0]!.rows).toEqual([
      { value: "m:p99:http.server.request.duration", name: latency.name, plain: false, tag: "histogram", amber: false, on: true },
    ]);
    const listed = list.sections.flatMap((section) => section.rows.map((row) => row.name));
    expect(listed.filter((name) => name === latency.name)).toHaveLength(1);
  });
});
