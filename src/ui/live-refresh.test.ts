import { describe, expect, test } from "bun:test";
import { LiveRefresh, type RefreshRun } from "./live-refresh";

type Pending = { resolve: (landed: boolean) => void; signal: AbortSignal };

function harness() {
  let now = 0;
  const reg = new LiveRefresh(() => now);
  const calls: Record<string, Pending[]> = {};
  const runner =
    (key: string): RefreshRun =>
    (signal) =>
      new Promise<boolean>((resolve) => {
        (calls[key] ??= []).push({ resolve, signal });
      });
  return {
    reg,
    calls,
    runner,
    at(ms: number) {
      now = ms;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function liveSearch(h: ReturnType<typeof harness>) {
  h.reg.register({ key: "poll", everyMs: 2_000, lane: "search", run: h.runner("poll") });
  h.reg.register({
    key: "full",
    everyMs: 30_000,
    lane: "search",
    covers: ["poll"],
    run: h.runner("full"),
  });
}

describe("LiveRefresh", () => {
  test("starts an entry when its cadence is due, with setInterval slack", () => {
    const h = harness();
    h.reg.register({ key: "facets", everyMs: 30_000, run: h.runner("facets") });
    h.at(29_000);
    expect(h.reg.tick()).toEqual([]);
    h.at(29_600);
    expect(h.reg.tick()).toEqual(["facets"]);
  });

  test("records fetchedAt only when the run lands", async () => {
    const h = harness();
    h.reg.register({ key: "facets", everyMs: 30_000, run: h.runner("facets") });
    h.at(30_000);
    h.reg.tick();
    h.at(30_400);
    h.calls.facets![0]!.resolve(false);
    await flush();
    expect(h.reg.fetchedAt("facets")).toBeUndefined();
    h.at(60_000);
    h.reg.tick();
    h.at(60_250);
    h.calls.facets![1]!.resolve(true);
    await flush();
    expect(h.reg.fetchedAt("facets")).toBe(60_250);
  });

  test("an in-flight entry is not started again", async () => {
    const h = harness();
    h.reg.register({ key: "poll", everyMs: 2_000, run: h.runner("poll") });
    h.at(2_000);
    expect(h.reg.tick()).toEqual(["poll"]);
    h.at(4_000);
    expect(h.reg.tick()).toEqual([]);
    h.calls.poll![0]!.resolve(true);
    await flush();
    h.at(6_000);
    expect(h.reg.tick()).toEqual(["poll"]);
  });

  test("the full pass wins its lane and covers the 2s delta", async () => {
    const h = harness();
    liveSearch(h);
    h.at(30_000);
    expect(h.reg.tick()).toEqual(["full"]);
    h.at(32_000);
    expect(h.reg.tick()).toEqual([]);
    h.at(32_100);
    h.calls.full![0]!.resolve(true);
    await flush();
    expect(h.reg.fetchedAt("full")).toBe(32_100);
    expect(h.reg.fetchedAt("poll")).toBe(32_100);
    h.at(34_000);
    expect(h.reg.tick()).toEqual(["poll"]);
  });

  test("a due full pass aborts a slow delta poll", () => {
    const h = harness();
    liveSearch(h);
    h.at(28_000);
    expect(h.reg.tick()).toEqual(["poll"]);
    h.at(30_000);
    expect(h.reg.tick()).toEqual(["full"]);
    expect(h.calls.poll![0]!.signal.aborted).toBe(true);
  });

  test("an aborted run that resolves later does not stamp fetchedAt", async () => {
    const h = harness();
    h.reg.register({ key: "facets", everyMs: 30_000, run: h.runner("facets") });
    h.at(30_000);
    h.reg.tick();
    h.reg.abort(["facets"]);
    h.calls.facets![0]!.resolve(true);
    await flush();
    expect(h.reg.fetchedAt("facets")).toBeUndefined();
    expect(h.reg.inflight("facets")).toBe(false);
  });

  test("runNow restarts the clock and replaces an in-flight run", () => {
    const h = harness();
    h.reg.register({ key: "facets", everyMs: 30_000, run: h.runner("facets") });
    h.at(30_000);
    h.reg.tick();
    h.at(31_000);
    h.reg.runNow(["facets"]);
    expect(h.calls.facets![0]!.signal.aborted).toBe(true);
    expect(h.calls.facets).toHaveLength(2);
    h.at(60_000);
    expect(h.reg.tick()).toEqual([]);
    h.at(61_000);
    expect(h.reg.tick()).toEqual([]);
  });

  test("touch restarts cadence; landed touch stamps fetchedAt", () => {
    const h = harness();
    liveSearch(h);
    h.at(20_000);
    h.reg.touch(["poll", "full"], true);
    expect(h.reg.fetchedAt("full")).toBe(20_000);
    h.at(30_000);
    expect(h.reg.tick()).toEqual(["poll"]);
  });

  test("snapshot and restore carry freshness with a workspace paint", async () => {
    const h = harness();
    h.reg.register({ key: "facets", everyMs: 30_000, run: h.runner("facets") });
    h.reg.touch(["facets"], true);
    const snap = h.reg.snapshot();
    expect(snap).toEqual({ facets: 0 });
    h.at(5_000);
    h.reg.touch(["facets"], true);
    let heard = 0;
    const off = h.reg.subscribe(() => {
      heard += 1;
    });
    h.reg.restore(snap);
    off();
    expect(h.reg.fetchedAt("facets")).toBe(0);
    expect(heard).toBe(1);
    h.reg.restore({});
    expect(h.reg.fetchedAt("facets")).toBeUndefined();
  });

  test("re-registering keeps timing and in-flight state", async () => {
    const h = harness();
    h.reg.register({ key: "poll", everyMs: 2_000, run: h.runner("poll") });
    h.at(2_000);
    h.reg.tick();
    h.reg.register({ key: "poll", everyMs: 2_000, run: h.runner("poll") });
    expect(h.reg.inflight("poll")).toBe(true);
    h.calls.poll![0]!.resolve(true);
    await flush();
    expect(h.reg.inflight("poll")).toBe(false);
    expect(h.reg.fetchedAt("poll")).toBe(2_000);
  });
});
