import { describe, expect, test } from "bun:test";
import { fakeFramedFingerprint } from "../src/shared/fake-event";
import { computeFingerprint } from "../src/shared/fingerprint";
import {
  buildHuntSlice,
  huntBugFingerprint,
  huntFirstSeen,
  huntStillHere,
  HUNT_MARK_ID,
  HUNT_Q,
  HUNT_WINDOW_MS,
} from "./hunt-billing-v09-events";

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

  test("still-here timeouts sit on both sides", () => {
    const before = slice.events.filter(
      (event) =>
        event.service === "billing" &&
        event.level === "error" &&
        event.message === huntStillHere.message &&
        Date.parse(event.ts) < slice.markMs,
    );
    const after = slice.events.filter(
      (event) =>
        event.service === "billing" &&
        event.level === "error" &&
        event.message === huntStillHere.message &&
        Date.parse(event.ts) > slice.markMs,
    );
    expect(before.length).toBe(huntStillHere.before);
    expect(after.length).toBe(huntStillHere.after);
  });

  test("billing errors rise after the mark", () => {
    expect(slice.billingErrorAfter).toBeGreaterThan(slice.billingErrorBefore);
    expect(slice.billingErrorBefore).toBe(huntStillHere.before);
    expect(slice.billingErrorAfter).toBe(
      huntStillHere.after +
        huntFirstSeen.reduce((sum, bug) => sum + bug.after, 0),
    );
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
});
