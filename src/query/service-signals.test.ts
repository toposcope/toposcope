import { describe, expect, test } from "bun:test";
import { foldMetricNames } from "./service-signals";

describe("foldMetricNames (#420)", () => {
  test("a histogram's .count and .sum are its one name, counted by its count's points", () => {
    const rows = [
      { name: "http.server.request.duration.count", n: "12" },
      { name: "http.server.request.duration.sum", n: "12" },
      { name: "process.cpu.time", n: 30 },
      { name: "jobs.count", n: 4 },
    ];
    expect(foldMetricNames(rows, ["http.server.request.duration"])).toEqual([
      { name: "process.cpu.time", n: 30, histogram: false },
      { name: "http.server.request.duration", n: 12, histogram: true },
      { name: "jobs.count", n: 4, histogram: false },
    ]);
  });

  test("a histogram with buckets and no count points is still listed", () => {
    expect(foldMetricNames([], ["rpc.server.duration"])).toEqual([{ name: "rpc.server.duration", n: 0, histogram: true }]);
  });
});
