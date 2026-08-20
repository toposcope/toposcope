import { describe, expect, test } from "bun:test";
import { ReceivedRing } from "./received-ring";
import { fillMinuteCounts, formatRate, ratePerSecond } from "../shared/throughput";

describe("ReceivedRing", () => {
  test("counts the current second", () => {
    const t0 = 1_700_000_000_000;
    const ring = new ReceivedRing(t0);
    ring.add(3, t0);
    ring.add(2, t0 + 100);
    expect(ring.count(1, t0 + 100)).toBe(5);
  });

  test("rotates into older second slots", () => {
    const t0 = 1_700_000_000_000;
    const ring = new ReceivedRing(t0);
    ring.add(4, t0);
    ring.add(7, t0 + 1000);
    expect(ring.count(1, t0 + 1000)).toBe(7);
    expect(ring.count(2, t0 + 1000)).toBe(11);
  });

  test("drops events older than 60s", () => {
    const t0 = 1_700_000_000_000;
    const ring = new ReceivedRing(t0);
    ring.add(9, t0);
    expect(ring.count(60, t0 + 61_000)).toBe(0);
  });
});

describe("throughput helpers", () => {
  test("ratePerSecond is count over the window", () => {
    expect(ratePerSecond(120, 60)).toBe(2);
    expect(ratePerSecond(0, 60)).toBe(0);
  });

  test("formatRate compact", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(0.016)).toBe("0.02");
    expect(formatRate(3.2)).toBe("3.2");
    expect(formatRate(44.4)).toBe("44");
    expect(formatRate(1500)).toBe("1.5k");
  });

  test("fillMinuteCounts inserts zeros", () => {
    const from = Date.parse("2026-08-14T10:00:00.000Z");
    const to = Date.parse("2026-08-14T10:02:00.000Z");
    expect(
      fillMinuteCounts(from, to, [{ t: "2026-08-14T10:01:00.000Z", n: 4 }]),
    ).toEqual([
      { t: "2026-08-14T10:00:00.000Z", n: 0 },
      { t: "2026-08-14T10:01:00.000Z", n: 4 },
      { t: "2026-08-14T10:02:00.000Z", n: 0 },
    ]);
  });
});
