import { describe, expect, test } from "bun:test";
import { renderMetrics } from "../metrics";
import { createDropTally } from "./syslog";

function dropped(reason: string): number {
  const line = renderMetrics()
    .split("\n")
    .find((l) => l.startsWith(`toposcope_syslog_dropped_total{reason="${reason}"} `));
  return Number(line?.split(" ")[1] ?? Number.NaN);
}

// #465
describe("createDropTally", () => {
  test("counts each reason on /api/metrics", () => {
    const before = { full: dropped("queue_full"), failed: dropped("insert_failed"), unparsed: dropped("unparsed") };
    const drop = createDropTally({ log: () => {} });
    drop("queue_full", 3);
    drop("insert_failed", 500);
    drop("unparsed", 1);
    expect(dropped("queue_full")).toBe(before.full + 3);
    expect(dropped("insert_failed")).toBe(before.failed + 500);
    expect(dropped("unparsed")).toBe(before.unparsed + 1);
  });

  test("writes at most one line a minute, with the counts since the last one", () => {
    let t = 0;
    const lines: string[] = [];
    const drop = createDropTally({ now: () => t, log: (l) => lines.push(l) });
    drop("queue_full", 1);
    t = 10_000;
    drop("queue_full", 4);
    drop("unparsed", 2);
    expect(lines).toEqual(["syslog dropped rows: queue full 1, insert failed 0, unparsed 0"]);
    t = 60_000;
    drop("insert_failed", 500);
    expect(lines[1]).toBe("syslog dropped rows: queue full 4, insert failed 500, unparsed 2");
  });
});
