import { describe, expect, test } from "bun:test";
import { embedAggResult, embedMessage, nextEmbedState, parseEmbedParams, pollMs, type SeriesBody } from "./embed-view";

const now = Date.parse("2026-10-23T14:02:00Z");
const body: SeriesBody = {
  from: "2026-10-22T14:00:00.000Z",
  to: "2026-10-23T14:00:00.000Z",
  step_ms: 900_000,
  series: { unit: "s", buckets: [{ t: "2026-10-22T14:00:00.000Z", v: 0.5 }] },
};

describe("embed params", () => {
  test("the panel's own params become the series query; the ticket stays out of it", () => {
    const p = parseEmbedParams("?ticket=tst1_x.1792800000000.sig&metric=fleet_cpu_seconds&reading=p99&range=24h&title=CPU&theme=light");
    expect(p.query.toString()).toBe("metric=p99%3Afleet_cpu_seconds&range=24h");
    expect(p.title).toBe("CPU");
    expect(p.what).toBe("fleet_cpu_seconds · p99");
    expect(p.theme).toBe("light");
    expect(p.ticketUntil).toBe(1792800000000);
    expect(parseEmbedParams("?agg=rate&split=host&range=1h").what).toBe("logs · rate · split host");
  });
});

describe("embed states", () => {
  test("a paint is kept, muted, through Toposcope not answering", () => {
    const painted = nextEmbedState({ kind: "loading" }, { status: 200, body }, now);
    expect(painted).toEqual({ kind: "painted", body, readAt: now });
    const stale = nextEmbedState(painted, { failed: true }, now + 60_000);
    expect(stale).toEqual({ kind: "stale", body, readAt: now, since: now + 60_000 });
    expect(nextEmbedState(stale, { status: 502, body: null }, now + 120_000)).toMatchObject({ since: now + 60_000 });
    expect(embedMessage(stale)).toBe("toposcope:stale");
  });

  test("expired and refused say so", () => {
    expect(nextEmbedState({ kind: "loading" }, { status: 401, body: { error: "Unauthorized" } }, now)).toEqual({ kind: "expired" });
    expect(nextEmbedState({ kind: "loading" }, { status: 400, body: { error: "this share's finest bar is 1m; step=10s is finer" } }, now)).toEqual({
      kind: "refused",
      error: "this share's finest bar is 1m; step=10s is finer",
    });
    expect(embedMessage({ kind: "expired" })).toBe("toposcope:expired");
    expect(embedMessage({ kind: "refused", error: "x" })).toBe("toposcope:ready");
  });

  test("polls at its bar, never faster than 30s", () => {
    expect(pollMs(body)).toBe(900_000);
    expect(pollMs({ ...body, step_ms: 60_000 })).toBe(60_000);
    expect(pollMs({ ...body, step_ms: 10_000 })).toBe(30_000);
  });
});

describe("embed plot", () => {
  test("a metric as it came, a log count as one line or one per split value", () => {
    expect(embedAggResult(body)).toMatchObject({ source: "metric", unit: "s", buckets: [{ t: body.from, v: 0.5 }] });
    const counted = embedAggResult({ ...body, series: undefined, agg: "count", buckets: [{ t: body.from!, n: 3, series: { a: 1, b: 2 } }] });
    expect(counted.stat).toBe(3);
    expect(counted.splits?.map((s) => s.key)).toEqual(["a", "b"]);
  });

  test("a Top-N reads /share/v1/top with its key and n", () => {
    const p = parseEmbedParams("?ticket=t&chart=top&key=host&n=5&range=24h&metric=ignored");
    expect(p.path).toBe("/share/v1/top");
    expect(p.query.toString()).toBe("key=host&n=5&range=24h");
    expect(p.what).toBe("top 5 by host");
    expect(parseEmbedParams("?chart=nope&metric=cpu").chart).toBe("line");
  });
});
