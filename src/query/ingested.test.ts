import { describe, expect, test } from "bun:test";
import { ingestedKind } from "./ingested";

describe("ingestedKind", () => {
  test("omits on load-more", () => {
    expect(
      ingestedKind({
        eventsOnly: true,
        isDelta: false,
        total: 0,
        eventCount: 0,
      }),
    ).toBe("omit");
  });

  test("is true when the window already has hits", () => {
    expect(
      ingestedKind({
        eventsOnly: false,
        isDelta: false,
        total: 12,
        eventCount: 0,
      }),
    ).toBe("true");
    expect(
      ingestedKind({
        eventsOnly: false,
        isDelta: false,
        total: 0,
        eventCount: 3,
      }),
    ).toBe("true");
  });

  test("omits live deltas so empty polls do not re-probe", () => {
    expect(
      ingestedKind({
        eventsOnly: false,
        isDelta: true,
        total: 0,
        eventCount: 0,
      }),
    ).toBe("omit");
  });

  test("probes an empty full-window search", () => {
    expect(
      ingestedKind({
        eventsOnly: false,
        isDelta: false,
        total: 0,
        eventCount: 0,
      }),
    ).toBe("probe");
  });
});
