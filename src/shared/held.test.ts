import { describe, expect, test } from "bun:test";
import { holeTimes } from "../links/store";
import { feeders, filterImplied, gapsIn, heldSources, huntAst, omitKey, shortIn, type HeldLink } from "./held";

const now = Date.parse("2026-08-14T15:00:00Z");
const at = (iso: string) => Date.parse(`2026-08-14T${iso}Z`);

function link(over: Partial<HeldLink> = {}): HeldLink {
  return {
    role: "pull",
    connects: "we",
    peer_name: "prod-eu",
    q: "",
    position: 100,
    settled: 100,
    arrived_at: "2026-08-14T14:59:58Z",
    last_contact_at: now - 2_000,
    last_error: null,
    created_at: now - 86_400_000,
    gone_from: null,
    gone_to: null,
    gone_from_at: null,
    gone_to_at: null,
    ...over,
  };
}

describe("where a source stands (#139)", () => {
  test("caught up, behind under 30s, behind, not answering, not called", () => {
    expect(heldSources([link()], now)[0]?.state).toEqual({ kind: "caught-up" });
    expect(heldSources([link({ position: 90, arrived_at: "2026-08-14T14:59:40Z" })], now)[0]?.state).toEqual({ kind: "caught-up" });
    expect(heldSources([link({ position: 90, arrived_at: "2026-08-14T14:56:02Z" })], now)[0]?.state).toEqual({
      kind: "behind",
      readTo: at("14:56:02"),
    });
    const quiet = heldSources([link({ last_contact_at: at("12:58:04"), last_error: "connect refused" })], now)[0]?.state;
    expect(quiet).toEqual({ kind: "quiet", since: at("12:58:04"), knownTo: at("12:58:04"), connects: "we" });
    const notCalled = heldSources([link({ connects: "they", last_contact_at: at("14:20:31") })], now)[0]?.state;
    expect(notCalled?.kind === "quiet" && notCalled.connects).toBe("they");
  });

  test("a quiet source that was behind is known only to what it had read", () => {
    const s = heldSources(
      [link({ position: 50, arrived_at: "2026-08-14T12:40:00Z", last_contact_at: at("12:58:04"), last_error: "timeout" })],
      now,
    )[0]!;
    expect(s.state).toEqual({ kind: "quiet", since: at("12:58:04"), knownTo: at("12:40:00"), connects: "we" });
    expect(gapsIn([s], { from: at("09:00:00"), to: now }, now)).toEqual([
      { source: "prod-eu", kind: "quiet", from: at("12:40:00"), to: now },
    ]);
  });

  test("serve links are not sources; two links from one source speak as its worst, unfiltered if either is", () => {
    const sources = heldSources(
      [
        link({ role: "serve", peer_name: "edge" }),
        link({ q: "level:warn" }),
        link({ q: "", position: 90, arrived_at: "2026-08-14T14:56:02Z" }),
        link({ peer_name: "billing-app", q: "level:error" }),
      ],
      now,
    );
    expect(sources.map((s) => [s.name, s.filters, s.state.kind])).toEqual([
      ["prod-eu", [], "behind"],
      ["billing-app", ["level:error"], "caught-up"],
    ]);
  });

  test("a hole is short only over windows that overlap it", () => {
    const s = heldSources(
      [link({ gone_from: 10, gone_to: 20, gone_from_at: "2026-08-09T18:40:00Z", gone_to_at: "2026-08-11T00:00:00Z" })],
      now,
    );
    expect(shortIn(s, { from: now - 7 * 86_400_000, to: now }, now).map((x) => x.name)).toEqual(["prod-eu"]);
    expect(shortIn(s, { from: now - 3_600_000, to: now }, now)).toEqual([]);
  });

  test("behind is short over a window that reaches past the read position, not over one that ends before it", () => {
    const s = heldSources([link({ position: 90, arrived_at: "2026-08-14T14:56:02Z" })], now);
    expect(shortIn(s, { from: at("14:00:00"), to: now }, now)).toHaveLength(1);
    expect(shortIn(s, { from: at("13:00:00"), to: at("14:00:00") }, now)).toHaveLength(0);
  });
});

describe("every count a short source could feed is a floor (#139)", () => {
  const behind = (over: Partial<HeldLink>) => link({ position: 90, arrived_at: "2026-08-14T14:56:02Z", ...over });

  test("an unfiltered short source feeds every count and every value, including ones it has not sent", () => {
    const short = heldSources([behind({})], now);
    expect(feeders(short, huntAst("level:error"))).toHaveLength(1);
    expect(feeders(short, huntAst(""), { key: "service", value: "api-us" })).toHaveLength(1);
  });

  test("exception 1: the hunt names other sources", () => {
    const short = heldSources([behind({})], now);
    expect(feeders(short, huntAst("toposcope:prod-us level:error"))).toEqual([]);
    expect(feeders(short, huntAst("toposcope:prod-eu level:error"))).toHaveLength(1);
    // In the group, a caught-up source's own count stays plain.
    expect(feeders(short, huntAst(""), { key: "toposcope", value: "prod-us" })).toEqual([]);
    expect(feeders(short, huntAst(""), { key: "toposcope", value: "prod-eu" })).toHaveLength(1);
    // Not a host or service that happens to live on one source.
    expect(feeders(short, huntAst("host:api-us-1"))).toHaveLength(1);
  });

  test("a facet counts its own field without the hunt's terms on it, so prod-eu's count is a floor under toposcope:prod-us", () => {
    const short = heldSources([behind({})], now);
    const hunt = huntAst("toposcope:prod-us level:error");
    expect(feeders(short, omitKey(hunt, "toposcope"), { key: "toposcope", value: "prod-eu" })).toHaveLength(1);
    expect(omitKey(huntAst("toposcope:a OR level:error"), "toposcope")).toBeNull();
    expect(omitKey(huntAst("toposcope:a level:error"), "toposcope")).toEqual(huntAst("level:error"));
  });

  test("exception 2: the short source's filter rules the value out by a plain key:value mismatch", () => {
    const short = heldSources([behind({ peer_name: "billing-app", q: "service:billing" })], now);
    expect(feeders(short, huntAst(""), { key: "service", value: "api" })).toEqual([]);
    expect(feeders(short, huntAst(""), { key: "service", value: "billing" })).toHaveLength(1);
    expect(feeders(short, huntAst(""))).toHaveLength(1);
    expect(feeders(short, huntAst("service:checkout"))).toEqual([]);
  });

  test("a glob or an OR in the filter is not read for exceptions", () => {
    const glob = heldSources([behind({ q: "status:5*" })], now);
    expect(feeders(glob, huntAst(""), { key: "status", value: "200" })).toHaveLength(1);
    const or = heldSources([behind({ q: "service:billing OR service:tax" })], now);
    expect(feeders(or, huntAst(""), { key: "service", value: "api" })).toHaveLength(1);
  });
});

describe("the scope chip (#139)", () => {
  test("a filter the hunt already implies cuts nothing the hunt kept", () => {
    expect(filterImplied("level:error", huntAst("level:error"))).toBe(true);
    expect(filterImplied("level:error", huntAst("service:billing level:error"))).toBe(true);
    expect(filterImplied("level:error", huntAst("service:billing"))).toBe(false);
    expect(filterImplied("level:error", huntAst(""))).toBe(false);
    expect(filterImplied("service:a level:error", huntAst("level:error"))).toBe(false);
  });
});

describe("a hole's ends in time (#139)", () => {
  const base = {
    position: 40,
    settled: 40,
    arrived_at: "2026-08-09T18:31:00.000Z",
    last_contact_at: Date.parse("2026-08-09T18:40:00Z"),
    created_at: 0,
    gone_from_at: null,
    gone_to_at: null,
  };

  test("from where the rows were known to, to the start of the oldest day the source keeps", () => {
    expect(holeTimes(base, { gone: { from: 41, to: 99 }, horizon: "2026-08-11T10:12:00.000Z" })).toEqual({
      gone_from_at: "2026-08-09T18:40:00.000Z",
      gone_to_at: "2026-08-11T00:00:00.000Z",
    });
    // Behind when it went quiet: known only to what it had read.
    expect(holeTimes({ ...base, settled: 60 }, { gone: { from: 41, to: 99 }, horizon: "2026-08-11T10:12:00.000Z" }).gone_from_at).toBe(
      "2026-08-09T18:31:00.000Z",
    );
  });

  test("no hole in the reply keeps what was recorded; a hole only grows", () => {
    const held = { ...base, gone_from_at: "2026-08-09T18:40:00.000Z", gone_to_at: "2026-08-11T00:00:00.000Z" };
    expect(holeTimes(held, { gone: null, horizon: "2026-08-12T00:00:00.000Z" })).toEqual({
      gone_from_at: held.gone_from_at,
      gone_to_at: held.gone_to_at,
    });
    expect(holeTimes(held, { gone: { from: 41, to: 120 }, horizon: "2026-08-12T09:00:00.000Z" }).gone_to_at).toBe(
      "2026-08-12T00:00:00.000Z",
    );
  });
});
