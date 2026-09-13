import { describe, expect, test } from "bun:test";
import { fakeFramedFingerprint } from "../src/shared/fake-event";
import { computeFingerprint } from "../src/shared/fingerprint";
import {
  buildHuntSlice,
  huntBugFingerprint,
  huntFirstSeen,
  huntHostPercents,
  huntHostSlices,
  huntStillHere,
  HUNT_MARK_ID,
  HUNT_PROBE_METRIC,
  HUNT_PROBE_ML,
  HUNT_Q,
  HUNT_WINDOW_MS,
} from "./hunt-billing-v09-events";
import {
  compareFoldPercent,
  formatCompareFoldPercent,
} from "../src/shared/compare-fold";

const now = Date.parse("2026-08-31T18:00:00.000Z");

describe("buildHuntSlice", () => {
  const slice = buildHuntSlice(now);

  test("pins a 1h window with the mark in the middle", () => {
    expect(slice.toMs - slice.fromMs).toBe(HUNT_WINDOW_MS);
    expect(slice.markMs).toBe(slice.fromMs + HUNT_WINDOW_MS / 2);
    expect(slice.mark.id).toBe(HUNT_MARK_ID);
    expect(slice.q).toBe(HUNT_Q);
  });

  test("keeps after-only bugs off the before side", () => {
    const afterOnly = new Set(huntFirstSeen.map((bug) => bug.message));
    for (const event of slice.events) {
      const ts = Date.parse(event.ts);
      if (
        event.service === "billing" &&
        ts < slice.markMs &&
        afterOnly.has(event.message)
      ) {
        throw new Error(`${event.message} appeared before the mark`);
      }
    }
    const afterMessages = slice.events
      .filter((event) => Date.parse(event.ts) > slice.markMs)
      .map((event) => event.message);
    for (const bug of huntFirstSeen) {
      expect(afterMessages.filter((m) => m === bug.message).length).toBe(
        bug.after,
      );
    }
  });

  test("still-here timeouts sit on both sides of each billing host", () => {
    const still = (host: string, side: "before" | "after") =>
      slice.events.filter((event) => {
        const ts = Date.parse(event.ts);
        const onSide =
          side === "before" ? ts < slice.markMs : ts > slice.markMs;
        return (
          event.service === "billing" &&
          event.level === "error" &&
          event.host === host &&
          event.message === huntStillHere.message &&
          onSide
        );
      });
    for (const hostSlice of huntHostSlices) {
      expect(still(hostSlice.host, "before").length).toBe(hostSlice.still);
      expect(still(hostSlice.host, "after").length).toBe(hostSlice.still);
    }
  });

  test("billing errors rise after the mark", () => {
    const stillTotal = huntHostSlices.reduce((sum, host) => sum + host.still, 0);
    expect(slice.billingErrorAfter).toBeGreaterThan(slice.billingErrorBefore);
    expect(slice.billingErrorBefore).toBe(stillTotal);
    expect(slice.billingErrorAfter).toBe(
      stillTotal + huntFirstSeen.reduce((sum, bug) => sum + bug.after, 0),
    );
  });

  test("split Host percents are 0.5 / 4 / 9 on the three billing hosts", () => {
    expect(huntFirstSeen.map((bug) => bug.after)).toEqual(
      huntHostSlices.map((host) => host.bugAfter),
    );
    const formatted = huntHostSlices.map((hostSlice) => {
      const before = slice.events.filter(
        (event) =>
          event.service === "billing" &&
          event.level === "error" &&
          event.host === hostSlice.host &&
          Date.parse(event.ts) < slice.markMs,
      ).length;
      const after = slice.events.filter(
        (event) =>
          event.service === "billing" &&
          event.level === "error" &&
          event.host === hostSlice.host &&
          Date.parse(event.ts) > slice.markMs,
      ).length;
      expect(before).toBe(hostSlice.still);
      expect(after).toBe(hostSlice.still + hostSlice.bugAfter);
      return formatCompareFoldPercent(compareFoldPercent(before, after) ?? 0);
    });
    expect(formatted).toEqual([...huntHostPercents]);
  });

  test("first-seen bugs have distinct fingerprints", () => {
    const hexes = huntFirstSeen.map(huntBugFingerprint);
    expect(new Set(hexes).size).toBe(huntFirstSeen.length);
    expect(hexes).not.toContain(fakeFramedFingerprint());
  });

  test("background does not share first-seen fingerprints", () => {
    const hexes = new Set(huntFirstSeen.map(huntBugFingerprint));
    const firstSeenMessages = new Set(huntFirstSeen.map((bug) => bug.message));
    for (const event of slice.events) {
      if (firstSeenMessages.has(event.message)) {
        continue;
      }
      const hex = computeFingerprint(event.level, event.message, event.attrs);
      if (hex && hexes.has(hex)) {
        throw new Error(
          `${event.service} ${event.message} collides with a first-seen e1`,
        );
      }
    }
  });

  test("does not stamp a load marker on messages", () => {
    for (const event of slice.events) {
      expect(event.message).not.toMatch(/load\d/);
    }
  });

  test("stamps version, customer, and flag on billing errors", () => {
    const billing = slice.events.filter(
      (event) => event.service === "billing" && event.level === "error",
    );
    expect(billing.length).toBeGreaterThan(0);
    for (const event of billing) {
      expect(event.attrs.customer).toBe("acme");
    }
    const after = billing.filter((event) => Date.parse(event.ts) > slice.markMs);
    for (const event of after) {
      expect(event.attrs.version).toBe("v0.9");
    }
    const firstSeenMessages = new Set(huntFirstSeen.map((bug) => bug.message));
    for (const event of after) {
      if (firstSeenMessages.has(event.message)) {
        expect(event.attrs.flag).toBe("new-checkout");
      }
    }
    expect(new Set(huntFirstSeen.map((bug) => bug.host)).size).toBe(3);
  });

  test("plants explicit up=0 after the mark, not a silent green", () => {
    const before = slice.probes.filter((probe) => Date.parse(probe.ts) <= slice.markMs);
    const after = slice.probes.filter((probe) => Date.parse(probe.ts) > slice.markMs);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(before.every((probe) => probe.up === 1)).toBe(true);
    expect(after.some((probe) => probe.up === 0)).toBe(true);
    expect(after.some((probe) => probe.up === 1)).toBe(true);
    const firstDown = after.find((probe) => probe.up === 0);
    expect(firstDown?.service).toBe("billing");
    expect(Date.parse(firstDown?.ts ?? "")).toBeGreaterThan(slice.markMs);
    expect(HUNT_PROBE_METRIC).toBe("up");
    expect(HUNT_PROBE_ML).toBe("service:billing");
  });
});
