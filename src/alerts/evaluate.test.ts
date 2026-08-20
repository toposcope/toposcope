import { describe, expect, test } from "bun:test";
import { shouldDeliver, shouldFire } from "./evaluate";

describe("shouldFire", () => {
  test("fires when value meets threshold and never fired", () => {
    expect(
      shouldFire({
        value: 3,
        threshold: 3,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(true);
  });

  test("does not fire below threshold", () => {
    expect(
      shouldFire({
        value: 2,
        threshold: 3,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(false);
  });

  test("fires a rate or p99 window stat at a fractional threshold", () => {
    expect(
      shouldFire({
        value: 0.5,
        threshold: 0.5,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(true);
    expect(
      shouldFire({
        value: 912,
        threshold: 800,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(true);
    expect(
      shouldFire({
        value: 0.4,
        threshold: 0.5,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(false);
  });

  test("respects cooldown", () => {
    expect(
      shouldFire({
        value: 9,
        threshold: 1,
        lastFiredAt: 800,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(false);
    expect(
      shouldFire({
        value: 9,
        threshold: 1,
        lastFiredAt: 400,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(true);
  });

  test("does not fire while silenced", () => {
    expect(
      shouldFire({
        value: 9,
        threshold: 1,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
        silencedUntil: 1500,
      }),
    ).toBe(false);
    expect(
      shouldFire({
        value: 9,
        threshold: 1,
        lastFiredAt: null,
        now: 1500,
        cooldownMs: 500,
        silencedUntil: 1500,
      }),
    ).toBe(true);
  });
});

describe("shouldDeliver", () => {
  test("skips a refused agg even when the window is busy", () => {
    expect(
      shouldDeliver({
        refused: true,
        value: 912,
        threshold: 1,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(false);
  });

  test("delivers a clear p99 window stat", () => {
    expect(
      shouldDeliver({
        refused: false,
        value: 912,
        threshold: 800,
        lastFiredAt: null,
        now: 1000,
        cooldownMs: 500,
      }),
    ).toBe(true);
  });
});
