import { describe, expect, test } from "bun:test";
import { fakeClientNets, fakeLogEvent } from "./fake-event";

function sample(n: number) {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  return Array.from({ length: n }, (_, i) =>
    fakeLogEvent({ i, n, now, windowMs: 3_600_000 }),
  );
}

describe("fakeLogEvent", () => {
  test("is deterministic for a given i", () => {
    const a = fakeLogEvent({ i: 42, n: 1000, now: 1, windowMs: 1000 });
    const b = fakeLogEvent({ i: 42, n: 1000, now: 1, windowMs: 1000 });
    expect(a).toEqual(b);
  });

  test("skews levels toward info and services toward api", () => {
    const events = sample(10_000);
    const levels: Record<string, number> = {};
    const services: Record<string, number> = {};
    const paths = new Set<string>();
    const statuses = new Set<number>();
    let withUser = 0;
    for (const event of events) {
      levels[event.level] = (levels[event.level] ?? 0) + 1;
      services[event.service] = (services[event.service] ?? 0) + 1;
      paths.add(String(event.attrs.path));
      statuses.add(Number(event.attrs.status));
      if (event.attrs.user_id) {
        withUser += 1;
      }
    }
    expect(levels.info ?? 0).toBeGreaterThan(levels.error ?? 0);
    expect(levels.error ?? 0).toBeGreaterThan(levels.fatal ?? 0);
    expect(services.api ?? 0).toBeGreaterThan(services.billing ?? 0);
    expect(paths.size).toBeGreaterThan(3);
    expect(statuses.size).toBeGreaterThan(3);
    expect(withUser).toBeGreaterThan(2000);
    expect(withUser).toBeLessThan(9000);
  });

  test("stamps client_ip on every event from a region-weighted public mix", () => {
    expect(fakeClientNets.reduce((sum, net) => sum + net.w, 0)).toBe(100);
    const events = sample(10_000);
    const ips = new Set<string>();
    const firstOctets = new Set<string>();
    let northAmerica = 0;
    let africa = 0;
    for (const event of events) {
      const ip = String(event.attrs.client_ip);
      const parts = ip.split(".").map(Number);
      expect(parts).toHaveLength(4);
      const [a, b, c, d] = parts;
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(223);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(254);
      expect(d === 255).toBe(false);
      expect(ip.startsWith("203.0.113.")).toBe(false);
      ips.add(ip);
      firstOctets.add(String(a));
      if (a === 73 || a === 174 || a === 12 || a === 24 || a === 99 || a === 142) {
        northAmerica += 1;
      }
      if (a === 41 || a === 156) {
        africa += 1;
      }
    }
    expect(ips.size).toBeGreaterThan(2000);
    expect(ips.size).toBeLessThan(10_000);
    expect(firstOctets.size).toBeGreaterThan(12);
    expect(northAmerica).toBeGreaterThan(africa);
  });
});
