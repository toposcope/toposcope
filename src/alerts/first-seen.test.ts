import { describe, expect, test } from "bun:test";
import type { AlertRule } from "../control/alerts";
import type { SavedSearch } from "../control/saved-searches";
import { compileQuery } from "../query/compile";
import type { ChangeMark } from "../shared/change-mark";
import { fingerprintCutWindows, fingerprintCutMinBeforeMs } from "../shared/fingerprint-cut";
import { evaluateFirstSeenRule, queryRulesOutService, type FirstSeenDeps } from "./first-seen";

const minute = 60_000;
const now = Date.parse("2026-10-16T11:00:00.000Z");

const mark = (id: string, over: Partial<ChangeMark> = {}): ChangeMark => ({
  id,
  ts: new Date(now - 18 * minute).toISOString(),
  end_ts: null,
  kind: "deploy",
  service: "api",
  title: "v0.9.3",
  attrs: {},
  ...over,
});

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "rule-1",
  name: "new bugs after a deploy",
  kind: "first_seen",
  last_mark: null,
  body_kind: "default",
  body_template: null,
  query: "level:error service:api",
  webhook_url: "https://hooks.example.com/page",
  saved_search_id: "saved-1",
  threshold: 1,
  enabled: 1,
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
  created_at: 0,
  source: "fingerprints",
  state: "ok",
  remind_every: "window",
  resolved_body: null,
  last_result: null,
  last_value: null,
  last_result_at: null,
  ...over,
});

const saved = { id: "saved-1", name: "api errors", query: "level:error service:api" } as SavedSearch;

type Cut = Awaited<ReturnType<FirstSeenDeps["cut"]>>;

function harness(opts: {
  marks: ChangeMark[];
  cut: (mark: ChangeMark) => Partial<Cut>;
  status?: number;
  publicUrl?: string | null;
  /** A fingerprint's first event; undefined leaves it unread. Default ten minutes ago. */
  firstTs?: (hex: string) => string | undefined;
}) {
  const sent = new Map<string, Set<string>>();
  const posts: Array<{ url: string; body: any; contentType: string }> = [];
  const evals: Array<{ status: string; error: string | null }> = [];
  const webhooks: Array<{ ok: boolean }> = [];
  const lastMarks: unknown[] = [];
  const deps: FirstSeenDeps = {
    marks: async () => opts.marks,
    cut: async ({ mark }) => {
      const markTs = Date.parse(mark.ts);
      const windows = fingerprintCutWindows({
        markTs,
        markEndTs: null,
        kind: mark.kind,
        huntFrom: markTs - fingerprintCutMinBeforeMs,
        huntTo: now,
        openedAt: now,
        minBeforeMs: fingerprintCutMinBeforeMs,
      });
      return { windows, firstSeen: [], refused: null, ...opts.cut(mark) };
    },
    details: async (_w, _c, hexes) =>
      new Map(
        hexes.flatMap((hex) => {
          const firstTs = opts.firstTs ? opts.firstTs(hex) : new Date(now - 10 * minute).toISOString();
          return firstTs ? [[hex, { hex, type: "TypeError", message: `boom ${hex}`, firstTs }] as const] : [];
        }),
      ),
    sent: (ruleId, markId) => sent.get(`${ruleId}/${markId}`) ?? new Set(),
    recordSent: (ruleId, markId, e1s) => {
      const key = `${ruleId}/${markId}`;
      sent.set(key, new Set([...(sent.get(key) ?? []), ...e1s]));
    },
    recordLastMark: (_id, m) => lastMarks.push(m),
    recordWebhook: (_id, attempt) => webhooks.push(attempt),
    recordEval: (_id, stamp) => evals.push(stamp),
    post: async (url, payload) => {
      let body: any = payload.body;
      try {
        body = JSON.parse(payload.body);
      } catch {}
      posts.push({ url, body, contentType: payload.contentType });
      const status = opts.status ?? 200;
      return { ok: status < 300, status: String(status), error: status < 300 ? null : "no" };
    },
    publicUrl: () => (opts.publicUrl === undefined ? "https://toposcope.example.com" : opts.publicUrl),
  };
  return { deps, sent, posts, evals, webhooks, lastMarks };
}

const row = (hex: string, after: number, before = 0) => ({ hex, before, after });

describe("which marks a first-seen alert watches (#107)", () => {
  const rules = (q: string, service: string) => queryRulesOutService(compileQuery(q).ast, service);

  test("a plain service mismatch rules a mark out; no service never does", () => {
    expect(rules("level:error service:api", "worker")).toBe(true);
    expect(rules("level:error service:api", "api")).toBe(false);
    expect(rules("level:error service:api", "")).toBe(false);
    expect(rules("level:error", "worker")).toBe(false);
    expect(rules("", "worker")).toBe(false);
  });

  test("an OR of services, a negation, a prefix, and an OR the service cannot settle", () => {
    expect(rules("(service:api OR service:web) level:error", "web")).toBe(false);
    expect(rules("(service:api OR service:web) level:error", "worker")).toBe(true);
    expect(rules("-service:api", "api")).toBe(true);
    expect(rules("-service:api", "web")).toBe(false);
    expect(rules("service:api*", "api-gw")).toBe(false);
    expect(rules("service:api*", "web")).toBe(true);
    expect(rules("service:api OR level:error", "worker")).toBe(false);
  });
});

describe("evaluateFirstSeenRule (#107)", () => {
  test("a deploy followed by a new error pages once, naming the mark and the e1", async () => {
    const deploy = mark("mk_v093");
    const h = harness({ marks: [deploy], cut: () => ({ firstSeen: [row("9b1e4c07a3f2d851", 14)] }) });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.posts).toHaveLength(1);
    const body = h.posts[0]!.body;
    expect(body.alert).toEqual({ id: "rule-1", name: "new bugs after a deploy", threshold: 1, kind: "first_seen" });
    expect(body.mark).toEqual({ id: "mk_v093", kind: "deploy", service: "api", title: "v0.9.3", ts: deploy.ts });
    expect(body.fingerprints).toEqual([
      { e1: "9b1e4c07a3f2d851", type: "TypeError", message: "boom 9b1e4c07a3f2d851", first_seen: new Date(now - 10 * minute).toISOString(), events: 14 },
    ]);
    expect(body.count).toBe(1);
    expect(body.more).toBe(0);
    const link = new URL(body.link);
    expect(link.searchParams.get("cut")).toBe("mk_v093");
    expect(link.searchParams.get("saved")).toBe("saved-1");
    expect(link.searchParams.get("to")).toBe(new Date(now).toISOString());
    expect(h.lastMarks).toEqual([{ id: "mk_v093", kind: "deploy", title: "v0.9.3", service: "api", ts: deploy.ts, count: 1, at: now }]);

    // The next minute, the same e1 does not page again.
    await evaluateFirstSeenRule(rule(), saved, now + minute, h.deps);
    expect(h.posts).toHaveLength(1);
    expect(h.evals.at(-1)).toEqual({ at: now + minute, status: "ok", error: null } as never);
  });

  test("only First seen rows with at least N events after the mark", async () => {
    const h = harness({ marks: [mark("mk_a")], cut: () => ({ firstSeen: [row("aaaaaaaaaaaaaaaa", 1), row("bbbbbbbbbbbbbbbb", 3)] }) });
    await evaluateFirstSeenRule(rule({ threshold: 2 }), saved, now, h.deps);
    expect(h.posts[0]!.body.fingerprints.map((f: { e1: string }) => f.e1)).toEqual(["bbbbbbbbbbbbbbbb"]);
    // The one below N is not marked sent: it pages once it has N.
    expect([...h.sent.get("rule-1/mk_a")!]).toEqual(["bbbbbbbbbbbbbbbb"]);
  });

  test("a mark whose service the q rules out, and incident and note marks, do not page", async () => {
    const h = harness({
      marks: [mark("mk_worker", { service: "worker" }), mark("mk_inc", { kind: "incident" }), mark("mk_note", { kind: "note" })],
      cut: () => ({ firstSeen: [row("cccccccccccccccc", 5)] }),
    });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.posts).toHaveLength(0);
  });

  test("a mark on no service is watched", async () => {
    const h = harness({ marks: [mark("mk_flag", { kind: "flag", service: "", title: "scaler.v2" })], cut: () => ({ firstSeen: [row("dddddddddddddddd", 2)] }) });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.body.mark.kind).toBe("flag");
  });

  test("a refused cut records refused and does not page", async () => {
    const h = harness({ marks: [mark("mk_big")], cut: () => ({ refused: "more than 200 fingerprints on a side" }) });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.posts).toHaveLength(0);
    expect(h.evals).toEqual([
      { at: now, status: "refused", error: "more than 200 fingerprints on a side after deployed: api v0.9.3 · 10:42" } as never,
    ]);
  });

  test("ten listed, the rest counted, all sent once", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i.toString(16).padStart(16, "0"), 20 - i));
    const h = harness({ marks: [mark("mk_many")], cut: () => ({ firstSeen: rows }) });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    const body = h.posts[0]!.body;
    expect(body.fingerprints).toHaveLength(10);
    expect(body.more).toBe(3);
    expect(body.count).toBe(13);
    expect(h.sent.get("rule-1/mk_many")!.size).toBe(13);
  });

  test("one call per mark", async () => {
    const h = harness({
      marks: [mark("mk_1", { title: "v0.9.2" }), mark("mk_2")],
      cut: (m) => ({ firstSeen: [row(m.id === "mk_1" ? "1111111111111111" : "2222222222222222", 1)] }),
    });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.posts.map((p) => p.body.mark.id)).toEqual(["mk_1", "mk_2"]);
  });

  describe("a fingerprint new after a burst of deploys pages once", () => {
    const at = (min: number) => new Date(now - min * minute).toISOString();
    const burst = [
      mark("mk_1", { title: "v0.9.1", ts: at(40) }),
      mark("mk_3", { title: "v0.9.3", ts: at(18) }),
      mark("mk_2", { title: "v0.9.2", ts: at(30) }),
    ];
    const hex = "7777777777777777";

    test("for the latest deploy at or before its first event, and never again", async () => {
      const h = harness({ marks: burst, cut: () => ({ firstSeen: [row(hex, 4)] }), firstTs: () => at(10) });
      await evaluateFirstSeenRule(rule(), saved, now, h.deps);
      expect(h.posts.map((p) => p.body.mark.id)).toEqual(["mk_3"]);
      for (const id of ["mk_1", "mk_2", "mk_3"]) {
        expect(h.sent.get(`rule-1/${id}`)).toEqual(new Set([hex]));
      }
      await evaluateFirstSeenRule(rule(), saved, now + minute, h.deps);
      expect(h.posts).toHaveLength(1);
    });

    test("first seen between two deploys: the earlier one", async () => {
      const h = harness({ marks: burst, cut: () => ({ firstSeen: [row(hex, 4)] }), firstTs: () => at(35) });
      await evaluateFirstSeenRule(rule(), saved, now, h.deps);
      expect(h.posts.map((p) => p.body.mark.id)).toEqual(["mk_1"]);
    });

    test("its first event unread: the latest deploy it is new after", async () => {
      const h = harness({ marks: burst, cut: () => ({ firstSeen: [row(hex, 4)] }), firstTs: () => undefined });
      await evaluateFirstSeenRule(rule(), saved, now, h.deps);
      expect(h.posts.map((p) => p.body.mark.id)).toEqual(["mk_3"]);
    });

    test("a fingerprint new after one deploy only still pages for it, beside the shared one", async () => {
      const h = harness({
        marks: burst,
        cut: (m) => ({ firstSeen: m.id === "mk_1" ? [row(hex, 4), row("1111111111111111", 2)] : [row(hex, 4)] }),
        firstTs: () => at(10),
      });
      await evaluateFirstSeenRule(rule(), saved, now, h.deps);
      expect(h.posts.map((p) => [p.body.mark.id, p.body.fingerprints.map((f: { e1: string }) => f.e1)])).toEqual([
        ["mk_1", ["1111111111111111"]],
        ["mk_3", [hex]],
      ]);
    });

    test("a failed call leaves it unsent for every deploy", async () => {
      const h = harness({ marks: burst, cut: () => ({ firstSeen: [row(hex, 4)] }), firstTs: () => at(10), status: 500 });
      await evaluateFirstSeenRule(rule(), saved, now, h.deps);
      expect(h.sent.size).toBe(0);
    });
  });

  test("a failed call is not marked sent, so the next minute tries again", async () => {
    const h = harness({ marks: [mark("mk_fail")], cut: () => ({ firstSeen: [row("eeeeeeeeeeeeeeee", 1)] }), status: 500 });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect(h.webhooks).toEqual([{ at: now, ok: false, status: "500", error: "no" } as never]);
    expect(h.sent.size).toBe(0);
    await evaluateFirstSeenRule(rule(), saved, now + minute, h.deps);
    expect(h.posts).toHaveLength(2);
  });

  test("silenced: no call", async () => {
    const h = harness({ marks: [mark("mk_s")], cut: () => ({ firstSeen: [row("ffffffffffffffff", 1)] }) });
    await evaluateFirstSeenRule(rule({ silenced_until: now + 60 * minute }), saved, now, h.deps);
    expect(h.posts).toHaveLength(0);
  });

  test("without a public address the body has no link", async () => {
    const h = harness({ marks: [mark("mk_nolink")], cut: () => ({ firstSeen: [row("abababababababab", 1)] }), publicUrl: null });
    await evaluateFirstSeenRule(rule(), saved, now, h.deps);
    expect("link" in h.posts[0]!.body).toBe(false);
  });

  test("a Slack URL gets a Slack message naming the mark", async () => {
    const h = harness({ marks: [mark("mk_slack")], cut: () => ({ firstSeen: [row("1212121212121212", 1), row("3434343434343434", 1)] }) });
    await evaluateFirstSeenRule(rule({ webhook_url: "https://hooks.slack.com/services/T0/B0/X" }), saved, now, h.deps);
    const text = h.posts[0]!.body.blocks[0].text.text as string;
    expect(text).toStartWith("*new bugs after a deploy* fired\n`level:error service:api`\n2 new fingerprints after deploy v0.9.3\n<https://toposcope.example.com/?");
    expect(text).toEndWith("|Open in Toposcope>");
  });
});
