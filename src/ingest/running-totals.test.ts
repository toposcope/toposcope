import { describe, expect, test } from "bun:test";
import { RunningTotals } from "./running-totals";

const BOOT = 1_000_000;
/** A process that booted at BOOT and whose clock the test moves. */
function totals(opts: { maxSeries?: number; idleMs?: number } = {}) {
  const clock = { now: BOOT + 60_000 };
  return { clock, state: new RunningTotals(BOOT, () => clock.now, opts.maxSeries, opts.idleMs) };
}

describe("a series seen for the first time", () => {
  test("is counted whole when it started after this process did", () => {
    const { state } = totals();
    // Started 20s ago by its own clock; this process has been up 60s.
    expect(state.advance("a", 5_000_000, 5_020_000, [7])).toEqual([7]);
  });

  test("only sets the baseline when it was already running before this process started", () => {
    const { state } = totals();
    // Ten minutes old by its own clock; this process has been up one.
    expect(state.advance("a", 5_000_000, 5_600_000, [4_200])).toBeNull();
    expect(state.advance("a", 5_000_000, 5_660_000, [4_230])).toEqual([30]);
  });

  test("only sets the baseline when it does not say when it started", () => {
    const { state } = totals();
    expect(state.advance("a", 0, 5_020_000, [7])).toBeNull();
    expect(state.advance("a", 0, 5_080_000, [9])).toEqual([2]);
  });

  test("a sender whose clock is far off is judged by its own clock alone", () => {
    const { state } = totals();
    const skew = 86_400_000 * 400;
    expect(state.advance("young", skew + 5_000_000, skew + 5_020_000, [7])).toEqual([7]);
    expect(state.advance("old", skew + 5_000_000, skew + 5_600_000, [4_200])).toBeNull();
  });
});

describe("a series seen again", () => {
  test("gives the amount since it was last seen", () => {
    const { state } = totals();
    state.advance("a", 5_000_000, 5_020_000, [7]);
    expect(state.advance("a", 5_000_000, 5_080_000, [12])).toEqual([5]);
    expect(state.advance("a", 5_000_000, 5_140_000, [12])).toEqual([0]);
  });

  test("a missed export is not a loss: the next one carries both", () => {
    const { state } = totals();
    state.advance("a", 5_000_000, 5_020_000, [7]);
    // The export at 5_080_000 never arrived.
    expect(state.advance("a", 5_000_000, 5_140_000, [19])).toEqual([12]);
  });

  test("a total that went down is a restart, counted whole", () => {
    const { state } = totals();
    state.advance("a", 0, 5_020_000, [900]);
    state.advance("a", 0, 5_080_000, [950]);
    expect(state.advance("a", 0, 5_140_000, [3])).toEqual([3]);
  });

  test("a new start time is a restart even when the total is higher", () => {
    const { state } = totals();
    state.advance("a", 5_000_000, 5_020_000, [7]);
    expect(state.advance("a", 5_100_000, 5_140_000, [40])).toEqual([40]);
  });

  test("the same point twice, or an older one, adds nothing and changes nothing", () => {
    const { state } = totals();
    state.advance("a", 5_000_000, 5_020_000, [7]);
    state.advance("a", 5_000_000, 5_080_000, [12]);
    expect(state.advance("a", 5_000_000, 5_080_000, [12])).toEqual([0]);
    expect(state.advance("a", 5_000_000, 5_020_000, [7])).toEqual([0]);
    expect(state.advance("a", 5_000_000, 5_140_000, [15])).toEqual([3]);
  });

  test("a histogram's count and sum move together, and the count decides a restart", () => {
    const { state } = totals();
    state.advance("h", 5_000_000, 5_020_000, [10, 2.5]);
    expect(state.advance("h", 5_000_000, 5_080_000, [14, 2.0])).toEqual([4, -0.5]);
    expect(state.advance("h", 5_000_000, 5_140_000, [2, 9.9])).toEqual([2, 9.9]);
  });

  test("two series do not share a total", () => {
    const { state } = totals();
    state.advance("a", 5_000_000, 5_020_000, [7]);
    state.advance("b", 5_000_000, 5_020_000, [100]);
    expect(state.advance("a", 5_000_000, 5_080_000, [9])).toEqual([2]);
    expect(state.advance("b", 5_000_000, 5_080_000, [101])).toEqual([1]);
  });
});

describe("what is kept in memory", () => {
  test("a series not seen for a while is forgotten, and is then seen for the first time", () => {
    const { state, clock } = totals({ idleMs: 60_000 });
    state.advance("gone", 5_000_000, 5_020_000, [7]);
    clock.now += 120_000;
    state.advance("other", 5_000_000, 5_140_000, [1]);
    expect(state.size).toBe(1);
    // It kept running all along, so it is older than it would need to be to be counted whole.
    clock.now = BOOT + 30_000;
    expect(state.advance("gone", 5_000_000, 5_200_000, [30])).toBeNull();
  });

  test("the number of series is bounded, oldest out first", () => {
    const { state } = totals({ maxSeries: 3 });
    for (const key of ["a", "b", "c", "d"]) {
      state.advance(key, 5_000_000, 5_020_000, [1]);
    }
    expect(state.size).toBe(3);
    expect(state.advance("d", 5_000_000, 5_050_000, [3])).toEqual([2]);
    // "a" was pushed out, and is seen for the first time again: young enough to be counted whole.
    expect(state.advance("a", 5_000_000, 5_050_000, [9])).toEqual([9]);
  });
});
