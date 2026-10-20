import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { getAlert, readMonitorFields, recordEvalAttempt, recordWebhookAttempt, type AlertRule } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import type { SavedSearch } from "../control/saved-searches";
import { heldSources, type HeldLink } from "../shared/held";
import type { LogEvent } from "../shared/log-event";
import { cantTellWords, fewerThanProblem, opensWhenWords, type CantTell } from "../shared/monitor";
import { cantTellHeld, cantTellNow, markStarted, searchCantTell } from "./cant-tell";
import type { WebhookOutcome } from "./delivery";
import { forgetLastLines, lastLineAt, lastLineStore } from "./last-line";
import { passSearchMonitor, searchWindowMs, type SearchMonitorDeps } from "./monitor";
import { monitorHistory, openStretch } from "./monitor-store";
import { alertWebhookBody, readingMessage, type WebhookPayload } from "./payload";
import type { AlertSeries } from "./series";

const minute = 60_000;
const t0 = Date.parse("2026-10-20T10:26:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const ciBox = {
  id: "saved-ci",
  name: "ci-box lines",
  query: "host:ci-box",
  range: "15m",
  from_ts: null,
  to_ts: null,
  agg: null,
} as SavedSearch;

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateControlDb(db);
  return db;
}

function addRule(db: Database, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: "quiet-1",
    name: "ci-box went quiet",
    query: ciBox.query,
    webhook_url: "https://ntfy.example.com/agental-ops",
    saved_search_id: ciBox.id,
    threshold: 1,
    enabled: 1,
    created_at: t0 - 60 * minute,
    kind: "threshold",
    body_kind: "default",
    body_template: null,
    source: "search",
    remind_every: "4h",
    resolved_body: null,
    silenced_until: null,
    opens_when: "fewer_than",
    ...over,
  };
  const cols = Object.keys(row);
  db.query(`INSERT INTO alert_rules (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
  return row.id as string;
}

/**
 * A quiet-stream monitor over lines the test writes: each pass counts the lines in the last 15m,
 * as ClickHouse would. Toposcope started `startedAt`; linked sources are the test's to set.
 */
function rig(db: Database, opts: { startedAt?: number; saved?: SavedSearch; links?: HeldLink[] } = {}) {
  const lines: number[] = [];
  const reading: { refused: boolean; throws: boolean; value: number | null } = { refused: false, throws: false, value: null };
  const sent: Array<{ at: number; json: Record<string, unknown> | null }> = [];
  const saved = opts.saved ?? ciBox;
  let clock = t0;
  let links = opts.links ?? [];
  const deps: SearchMonitorDeps = {
    db,
    read: async (s): Promise<AlertSeries> => {
      if (reading.throws) {
        throw new Error("ClickHouse is down");
      }
      if (reading.refused) {
        return { expr: null, count: 0, value: 0, refused: true, reason: "read budget" };
      }
      const windowMs = searchWindowMs(s);
      const n = lines.filter((at) => at > clock - windowMs && at <= clock).length;
      const value = reading.value ?? n;
      return { expr: s.agg, count: n, value, refused: false };
    },
    post: async (_url: string, payload: WebhookPayload): Promise<WebhookOutcome> => {
      sent.push({ at: clock, json: JSON.parse(payload.body) as Record<string, unknown> });
      return { ok: true, status: "200", error: null };
    },
    publicUrl: () => null,
    recordWebhook: recordWebhookAttempt,
    recordEval: recordEvalAttempt,
    cantTell: (s, windowMs, now) =>
      searchCantTell({
        query: s.query,
        windowMs,
        now,
        startedAt: opts.startedAt ?? t0 - 24 * 60 * minute,
        sources: heldSources(links, now),
      }),
  };
  return {
    lines,
    reading,
    sent,
    setLinks(next: HeldLink[]) {
      links = next;
    },
    rule: (): AlertRule => getAlert("quiet-1", db)!,
    /** One pass at t0 + `minutes`. */
    async at(minutes: number) {
      clock = t0 + minutes * minute;
      await passSearchMonitor(getAlert("quiet-1", db)!, saved, clock, deps);
    },
  };
}

function link(over: Partial<HeldLink> = {}): HeldLink {
  return {
    role: "pull",
    connects: "we",
    peer_name: "prod-us",
    q: "",
    position: 100,
    settled: 100,
    arrived_at: null,
    last_contact_at: null,
    last_error: null,
    created_at: t0 - 24 * 60 * minute,
    gone_from: null,
    gone_to: null,
    gone_from_at: null,
    gone_to_at: null,
    ...over,
  };
}

describe("a search that goes quiet: fewer than (#176)", () => {
  test("host:ci-box over 15m, fewer than 1, opens 15 minutes after the last line and resolves on the next", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    // The last line from the box, at 10:26:41.
    m.lines.push(t0 + 41_000);
    await m.at(1);
    expect(m.rule().state).toBe("ok");
    expect(m.rule().last_result).toBe("ok");
    for (let i = 2; i <= 15; i++) {
      await m.at(i);
    }
    // At 10:41:00 the line is still inside the last 15m.
    expect(m.rule().state).toBe("ok");
    expect(m.sent).toHaveLength(0);
    // The first pass more than 15 minutes after it.
    await m.at(16);
    expect(m.rule().state).toBe("open");
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open"]);
    expect(m.sent[0]!.json).toMatchObject({
      alert: { name: "ci-box went quiet", threshold: 1, opens_when: "fewer_than" },
      count: 0,
      value: 0,
      state: "open",
      opened_at: iso(t0 + 16 * minute),
    });
    expect(openStretch("quiet-1", db)?.open_message).toBe("no line for 15m");
    await m.at(17);
    await m.at(30);
    expect(m.sent).toHaveLength(1);
    // The next line resolves it.
    m.lines.push(t0 + 30 * minute + 12_000);
    await m.at(31);
    expect(m.rule().state).toBe("ok");
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "resolved"]);
    expect(m.sent[1]!.json).toMatchObject({ state: "resolved", count: 1, resolved_at: iso(t0 + 31 * minute) });
    const [stretch] = monitorHistory("quiet-1", 200, db);
    expect(stretch).toMatchObject({ opened_at: t0 + 16 * minute, resolved_at: t0 + 31 * minute, closed_by: "ok" });
  });

  test("Slack reads it the right way round: fewer than opens below, resolves at or above", () => {
    const call = (state: "open" | "resolved") =>
      alertWebhookBody({
        url: "https://hooks.slack.com/services/T/B/x",
        alert: { id: "quiet-1", name: "ci-box went quiet", threshold: 1, opens_when: "fewer_than" },
        count: state === "open" ? 0 : 3,
        value: state === "open" ? 0 : 3,
        agg: null,
        query: "host:ci-box",
        firedAt: iso(t0),
        call: { state, openedAt: iso(t0), resolvedAt: state === "resolved" ? iso(t0) : null, duration: "22m" },
      }) as { text: string };
    expect(call("open").text).toBe("Toposcope: ci-box went quiet — Count 0 < 1");
    expect(call("resolved").text).toBe("Toposcope: ci-box went quiet resolved after 22m — Count 3 ≥ 1");
    // At least is as it was.
    const loud = alertWebhookBody({
      url: "https://hooks.slack.com/services/T/B/x",
      alert: { id: "a", name: "api errors", threshold: 50 },
      count: 57,
      value: 57,
      agg: null,
      query: "service:api",
      firedAt: iso(t0),
      call: { state: "open", openedAt: iso(t0), resolvedAt: null, duration: "0s" },
    }) as { text: string };
    expect(loud.text).toBe("Toposcope: api errors — Count 57 ≥ 50");
  });

  test("the result in words: no line for its window, or the count below the threshold", () => {
    expect(readingMessage(null, 0, 1, "fewer_than", "15m")).toBe("no line for 15m");
    expect(readingMessage(null, 2, 5, "fewer_than", "15m")).toBe("Count 2 < 5");
    expect(readingMessage("rate", 0, 0.5, "fewer_than", "15m")).toBe("rate 0 < 0.5");
    expect(readingMessage(null, 57, 50)).toBe("Count 57 ≥ 50");
    expect(opensWhenWords("fewer_than", null, 1)).toBe("fewer than 1");
    expect(opensWhenWords("fewer_than", "rate", 0.5)).toBe("rate fewer than 0.5");
    expect(opensWhenWords("at_least", "p99(duration_ms)", 800)).toBe("p99(duration_ms) at least 800");
  });

  test("on a rate, no rows is a rate of 0: it opens", async () => {
    const db = freshDb();
    addRule(db, { threshold: 0.5 });
    const m = rig(db, { saved: { ...ciBox, agg: "rate" } });
    m.reading.value = 0;
    await m.at(16);
    expect(m.rule().state).toBe("open");
    expect(openStretch("quiet-1", db)?.open_message).toBe("rate 0 < 0.5");
  });

  test("a refused or failed reading keeps it shut, and says which", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    m.reading.refused = true;
    await m.at(16);
    expect(m.rule().state).toBe("ok");
    expect(m.rule().last_status).toBe("refused");
    expect(cantTellWords(m.rule(), 15 * minute, t0 + 16 * minute)).toBe("a refused reading");
    m.reading.refused = false;
    m.reading.throws = true;
    await m.at(17);
    expect(m.rule().state).toBe("ok");
    expect(cantTellWords(m.rule(), 15 * minute, t0 + 17 * minute)).toBe("a failed reading");
    expect(m.sent).toHaveLength(0);
    // ClickHouse back, still no line: it can tell now.
    m.reading.throws = false;
    await m.at(18);
    expect(m.rule().state).toBe("open");
    expect(cantTellWords(m.rule(), 15 * minute, t0 + 18 * minute)).toBeNull();
  });

  test("a restart does not open it before 15 minutes of uptime", async () => {
    const db = freshDb();
    addRule(db);
    // Toposcope starts at 10:26; nothing came from the box before or since.
    const m = rig(db, { startedAt: t0 });
    await m.at(1);
    expect(m.rule().state).toBe("ok");
    expect(m.rule().cant_tell).toEqual({ kind: "starting", at: t0 + minute, until: t0 + 15 * minute });
    expect(cantTellWords(m.rule(), 15 * minute, t0 + 4 * minute)).toBe("starting, up 4m of 15m");
    for (let i = 2; i < 15; i++) {
      await m.at(i);
    }
    expect(m.rule().state).toBe("ok");
    expect(m.rule().last_result).toBeNull();
    expect(m.sent).toHaveLength(0);
    await m.at(15);
    expect(m.rule().state).toBe("open");
    expect(m.rule().cant_tell).toBeNull();
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open"]);
  });

  test("after a restart, a stretch open from before stays open until it can tell, and a line still resolves it", async () => {
    const db = freshDb();
    addRule(db);
    const before = rig(db);
    await before.at(0);
    expect(before.rule().state).toBe("open");
    // Restarted at t0 + 5m.
    const after = rig(db, { startedAt: t0 + 5 * minute });
    await after.at(6);
    expect(after.rule().state).toBe("open");
    expect(after.sent).toHaveLength(0);
    after.lines.push(t0 + 6 * minute + 30_000);
    await after.at(7);
    expect(after.rule().state).toBe("ok");
    expect(after.sent.map((s) => s.json?.state)).toEqual(["resolved"]);
  });

  test("a short linked source that could feed the count keeps it shut and says so", async () => {
    const db = freshDb();
    addRule(db);
    const now = t0 + 16 * minute;
    // prod-us has read its rows to 10:30 and is still behind.
    const behind = link({ position: 80, settled: 100, arrived_at: iso(t0 + 4 * minute), last_contact_at: now - 2_000 });
    const m = rig(db, { links: [behind] });
    await m.at(16);
    expect(m.rule().state).toBe("ok");
    expect(m.rule().cant_tell).toEqual({ kind: "held", at: now, sources: [{ name: "prod-us", state: "behind" }] });
    expect(cantTellWords(m.rule(), 15 * minute, now)).toBe("prod-us behind");
    expect(m.sent).toHaveLength(0);
    // Not answering since 10:28.
    m.setLinks([link({ last_contact_at: t0 + 2 * minute, last_error: "connection refused" })]);
    await m.at(17);
    expect(m.rule().cant_tell).toMatchObject({ kind: "held", sources: [{ name: "prod-us", state: "quiet" }] });
    expect(m.rule().state).toBe("ok");
    // Caught up again: it can tell, and nothing came from the box.
    m.setLinks([link({ last_contact_at: t0 + 18 * minute - 1_000 })]);
    await m.at(18);
    expect(m.rule().state).toBe("open");
    expect(m.rule().cant_tell).toBeNull();
  });

  test("a short source whose link rules this search out does not hold it", async () => {
    const db = freshDb();
    addRule(db);
    const now = t0 + 16 * minute;
    const elsewhere = link({ q: "host:web-1", position: 80, settled: 100, arrived_at: iso(t0), last_contact_at: now - 2_000 });
    const m = rig(db, { links: [elsewhere] });
    await m.at(16);
    expect(m.rule().state).toBe("open");
  });

  test("can't tell matters only when it would open: a line is a line", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db, { startedAt: t0 });
    m.lines.push(t0 + 30_000);
    await m.at(1);
    expect(m.rule().last_result).toBe("ok");
    expect(m.rule().cant_tell).toBeNull();
  });

  test("a search whose agg became p99, or whose window became fixed, is refused at the pass", async () => {
    const db = freshDb();
    addRule(db);
    const p99 = rig(db, { saved: { ...ciBox, agg: "p99:duration_ms" } });
    await p99.at(16);
    expect(p99.rule().state).toBe("ok");
    expect(p99.rule().last_status).toBe("refused");
    expect(p99.rule().last_error).toContain("fewer than reads a count or a rate");
    const fixed = rig(db, { saved: { ...ciBox, range: null, from_ts: iso(t0 - 15 * minute), to_ts: iso(t0) } });
    await fixed.at(17);
    expect(fixed.rule().state).toBe("ok");
    expect(fixed.rule().last_error).toContain("relative window");
  });

  test("at least is as it was: can't tell never holds a loud search", async () => {
    const db = freshDb();
    addRule(db, { opens_when: "at_least", threshold: 3 });
    const m = rig(db, { startedAt: t0 });
    m.lines.push(t0 + 10_000, t0 + 20_000, t0 + 30_000);
    await m.at(1);
    expect(m.rule().state).toBe("open");
    expect(m.rule().cant_tell).toBeNull();
  });
});

describe("what fewer than can read (#176)", () => {
  test("a count or a rate over a relative window; a percentile, an average or a fixed window are refused with a reason", () => {
    expect(fewerThanProblem({ agg: null, range: "15m" })).toBeNull();
    expect(fewerThanProblem({ agg: "rate", range: "15m" })).toBeNull();
    expect(fewerThanProblem({ agg: "p99:duration_ms", range: "15m" })).toBe(
      "fewer than reads a count or a rate; p99(duration_ms) over no lines has no value",
    );
    expect(fewerThanProblem({ agg: "avg:duration_ms", range: "15m" })).toContain("has no value");
    expect(fewerThanProblem({ agg: null, range: null })).toBe(
      "fewer than needs a relative window (range=15m), not a fixed from/to",
    );
  });
});

describe("can't tell, read now (#176)", () => {
  const original = cantTellHeld.links;
  afterEach(() => {
    cantTellHeld.links = original;
    markStarted(t0 - 24 * 60 * minute);
  });

  test("the editor's reading uses Toposcope's own start and its links", () => {
    cantTellHeld.links = () => [];
    markStarted(t0);
    expect(cantTellNow("host:ci-box", 15 * minute, t0 + 3 * minute)).toEqual({
      kind: "starting",
      at: t0 + 3 * minute,
      until: t0 + 15 * minute,
    });
    expect(cantTellNow("host:ci-box", 15 * minute, t0 + 15 * minute)).toBeNull();
    cantTellHeld.links = () => [link({ last_contact_at: t0, last_error: "timeout" })];
    const why = cantTellNow("host:ci-box", 15 * minute, t0 + 20 * minute) as CantTell;
    expect(why).toMatchObject({ kind: "held", sources: [{ name: "prod-us", state: "quiet" }] });
  });

  test("several short sources are named, two at most", () => {
    const why: CantTell = {
      kind: "held",
      at: t0,
      sources: [
        { name: "prod-us", state: "behind" },
        { name: "prod-eu", state: "quiet" },
        { name: "site-0417", state: "hole" },
      ],
    };
    expect(cantTellWords({ cant_tell: why, last_status: null }, 15 * minute, t0)).toBe("prod-us behind, prod-eu quiet +1");
  });
});

describe("last line (#176)", () => {
  const original = lastLineStore.newest;
  afterEach(() => {
    lastLineStore.newest = original;
    forgetLastLines();
  });

  test("the newest matching line, read once a refresh, and only back to the one it found", async () => {
    const asked: Array<[number, number]> = [];
    let newest = "2026-10-20T10:26:41.208Z";
    lastLineStore.newest = async (_q, from, to) => {
      asked.push([from, to]);
      return [{ ts: newest, service: "ci-runner", level: "info", message: "picked job" } as LogEvent];
    };
    const now = t0 + 37 * minute;
    expect(await lastLineAt("host:ci-box", now)).toBe(Date.parse(newest));
    expect(asked[0]![0]).toBe(now - 365 * 24 * 60 * minute);
    // Within the refresh: not read again.
    expect(await lastLineAt("host:ci-box", now + 10_000)).toBe(Date.parse(newest));
    expect(asked).toHaveLength(1);
    newest = "2026-10-20T11:05:00.000Z";
    expect(await lastLineAt("host:ci-box", now + 30_000)).toBe(Date.parse(newest));
    expect(asked[1]).toEqual([Date.parse("2026-10-20T10:26:41.208Z"), now + 30_000]);
  });

  test("none in a year is null; a refused read is not known, and keeps what was found", async () => {
    lastLineStore.newest = async () => [];
    expect(await lastLineAt("host:gone", t0)).toBeNull();
    lastLineStore.newest = async () => {
      throw new Error("read budget");
    };
    expect(await lastLineAt("host:never-read", t0)).toBeUndefined();
  });
});

describe("a monitor's fields (#176)", () => {
  test("fewer than 1 is legal, fewer than 0 is not; at least keeps threshold > 0", () => {
    // Each is refused before the saved search is looked up.
    expect(readMonitorFields({ name: "x", saved_search_id: "missing", webhook_url: "https://h.example/x", threshold: 0, opens_when: "fewer_than" }, null)).toEqual({
      error: "threshold must be > 0",
      status: 400,
    });
    expect(readMonitorFields({ name: "x", saved_search_id: "missing", webhook_url: "https://h.example/x", threshold: 1, opens_when: "below" }, null)).toEqual({
      error: "opens_when must be at_least or fewer_than",
      status: 400,
    });
    expect(
      readMonitorFields({ name: "x", source: "fingerprints", saved_search_id: "missing", webhook_url: "https://h.example/x", threshold: 1, opens_when: "fewer_than" }, null),
    ).toEqual({ error: "fewer than reads a saved search's series, not new fingerprints", status: 400 });
  });
});
