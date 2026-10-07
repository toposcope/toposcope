/**
 * A stock exporter sends counters and histograms as totals since the process
 * started. This keeps the last total of each series, in memory, and gives back
 * the amount since: what a delta exporter would have sent.
 */

type Seen = {
  /** The totals last seen. The first is the one that only goes up. */
  values: number[];
  /** When the series says it started, in ms on the sender's clock. 0 when it did not say. */
  startMs: number;
  /** The time of the point last seen, in ms on the sender's clock. */
  timeMs: number;
  /** When it was last seen, on this process's clock. */
  seenMs: number;
};

export class RunningTotals {
  /** Oldest first: a series is moved to the end each time it is seen. */
  private readonly series = new Map<string, Seen>();

  constructor(
    /** When this process started. A series younger than that was never counted before. */
    private readonly bootMs: number = Date.now(),
    private readonly now: () => number = Date.now,
    private readonly maxSeries = 200_000,
    /** A series not seen for this long is forgotten. If it comes back, it is seen for the first time. */
    private readonly idleMs = 15 * 60_000,
  ) {}

  get size(): number {
    return this.series.size;
  }

  /**
   * How much each total grew since the series was last seen.
   *
   * Seen for the first time, a series is counted whole when it started after
   * this process did: none of it can have been stored. Otherwise its totals are
   * only the baseline, and the answer is null. That is what a restart here
   * costs a series that was already running: one interval.
   *
   * A series that says it restarted, or whose first total went down, is counted
   * whole again. A point no newer than the last one seen adds nothing.
   */
  advance(key: string, startMs: number, timeMs: number, values: number[]): number[] | null {
    const nowMs = this.now();
    const last = this.series.get(key);
    if (last && timeMs <= last.timeMs) {
      return values.map(() => 0);
    }
    this.series.delete(key);
    this.series.set(key, { values, startMs, timeMs, seenMs: nowMs });
    this.forget(nowMs);

    if (!last) {
      // Both ages are differences on one clock, so a sender whose clock is off does not matter.
      const age = startMs > 0 ? timeMs - startMs : Number.POSITIVE_INFINITY;
      return age >= 0 && age <= nowMs - this.bootMs ? values : null;
    }
    const restarted =
      (startMs > 0 && last.startMs > 0 && startMs !== last.startMs) ||
      (values[0] ?? 0) < (last.values[0] ?? 0);
    return restarted ? values : values.map((value, i) => value - (last.values[i] ?? 0));
  }

  private forget(nowMs: number): void {
    for (const [key, seen] of this.series) {
      if (this.series.size <= this.maxSeries && nowMs - seen.seenMs <= this.idleMs) {
        break;
      }
      this.series.delete(key);
    }
  }
}
