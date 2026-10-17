import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { pingClickHouse } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { insertEvents } from "../ingest/index";
import { arrivalSeqSettled, resetArrivalSeqForTests } from "../ingest/arrival-seq";
import {
  defineFeed,
  ensureSeqProjection,
  feedRange,
  forgetOldestPosition,
  getFeed,
  listFeeds,
  readFeed,
  type FeedRow,
} from "./feed";

describe("feedRange (#135)", () => {
  test("reads after the position, through a span or what is settled, whichever is first", () => {
    expect(feedRange({ after: 0, settled: 40, oldest: 1 })).toEqual({ through: 40, gone: null });
    expect(feedRange({ after: 10, settled: 500_000, oldest: 1, span: 1_000 })).toEqual({ through: 1_010, gone: null });
    // Caught up: an empty range is an answer, not an end.
    expect(feedRange({ after: 40, settled: 40, oldest: 1 })).toEqual({ through: 40, gone: null });
  });

  test("positions retention passed before they were read are a hole, closed at both ends", () => {
    expect(feedRange({ after: 100, settled: 900, oldest: 500 })).toEqual({ through: 900, gone: { from: 101, to: 499 } });
    expect(feedRange({ after: 499, settled: 900, oldest: 500 }).gone).toBeNull();
    expect(feedRange({ after: 0, settled: 0, oldest: null }).gone).toBeNull();
  });
});

describe("defining a feed (#135)", () => {
  function db(): Database {
    const d = new Database(":memory:");
    d.run("CREATE TABLE feeds (id TEXT PRIMARY KEY, q TEXT NOT NULL, created_at INTEGER NOT NULL)");
    return d;
  }

  test("a bad q is refused when the feed is defined", () => {
    const d = db();
    const bad = defineFeed('level:error message:"unclosed', d);
    expect("faults" in bad && bad.faults.length > 0).toBe(true);
    expect(listFeeds(d)).toEqual([]);
  });

  test("a good q is kept as written, and an empty one is every row", () => {
    const d = db();
    const one = defineFeed("  service:checkout level:error ", d);
    const all = defineFeed("", d);
    if ("faults" in one || "faults" in all) throw new Error("expected feeds");
    expect(getFeed(one.id, d)?.q).toBe("service:checkout level:error");
    expect(getFeed(all.id, d)?.q).toBe("");
    expect(listFeeds(d).map((f) => f.id)).toEqual([one.id, all.id]);
  });
});

describe("reading a feed (#135)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the feed");
    await migrateStore();
    await ensureSeqProjection();
    // Idempotent: a second feed does not build it again.
    await ensureSeqProjection();
  });

  async function pageAll(q: string, from: number): Promise<{ rows: FeedRow[]; through: number }> {
    const rows: FeedRow[] = [];
    let after = from;
    for (let i = 0; i < 1_000; i++) {
      const reply = await readFeed({ id: "f_test", q, after, limit: 50 });
      rows.push(...reply.rows);
      expect(reply.through).toBeGreaterThanOrEqual(after);
      if (reply.through === after && reply.through >= reply.settled) {
        break;
      }
      after = reply.through;
    }
    return { rows, through: after };
  }

  test("a reader paging from zero, through late rows and a restart, ends with exactly the matching rows", async () => {
    forgetOldestPosition();
    const service = `feed${Date.now().toString(36)}`;
    const q = `service:${service} level:error`;
    const now = Date.now();
    const row = (i: number, level: "error" | "info", ago = 1_000) => ({
      ts: new Date(now - ago).toISOString(),
      service,
      level,
      message: `${level} ${i}`,
    });
    await insertEvents(Array.from({ length: 130 }, (_, i) => row(i, i % 2 ? "error" : "info")));
    const first = await pageAll(q, 0);
    // An hour late, then a restart of the source, then more.
    await insertEvents(Array.from({ length: 20 }, (_, i) => row(200 + i, "error", 3_600_000)));
    resetArrivalSeqForTests();
    await insertEvents(Array.from({ length: 30 }, (_, i) => row(300 + i, i % 3 ? "info" : "error")));
    const second = await pageAll(q, first.through);

    const got = [...first.rows, ...second.rows].map((r) => r.message);
    const want = [
      ...Array.from({ length: 130 }, (_, i) => i).filter((i) => i % 2).map((i) => `error ${i}`),
      ...Array.from({ length: 20 }, (_, i) => `error ${200 + i}`),
      ...Array.from({ length: 30 }, (_, i) => i).filter((i) => i % 3 === 0).map((i) => `error ${300 + i}`),
    ];
    expect(got.sort()).toEqual(want.sort());
    const seqs = [...first.rows, ...second.rows].map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(second.through).toBeGreaterThanOrEqual(arrivalSeqSettled());
  });

  test("rows come as stored, e1 included, and the reply says when the range's end arrived", async () => {
    forgetOldestPosition();
    const service = `feede1${Date.now().toString(36)}`;
    const before = arrivalSeqSettled();
    await insertEvents([
      {
        ts: new Date().toISOString(),
        service,
        level: "error",
        message: "TypeError: x is undefined",
        attrs: { "exception.type": "TypeError", "exception.stacktrace": "TypeError: x is undefined\n    at run (/app/a.js:1:1)" },
      },
    ]);
    const reply = await readFeed({ id: "f_test", q: `service:${service}`, after: before });
    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0]?.attrs.e1).toMatch(/^[0-9a-f]{16}$/);
    expect(reply.arrived).not.toBeNull();
    expect(Math.abs(Date.parse(reply.arrived!) - Date.now())).toBeLessThan(60_000);
    expect(reply.oldest).not.toBeNull();
    expect(reply.gone).toBeNull();
    // Caught up: the next read is an empty range, said as such.
    const next = await readFeed({ id: "f_test", q: `service:${service}`, after: reply.through });
    expect(next.rows).toEqual([]);
    expect(next.through).toBe(reply.through);
    expect(next.arrived).toBeNull();
  });
});

describe("marks in a feed (#138)", () => {
  test("a mark posted in the range comes with it, unless the filter rules its service out", async () => {
    const { clickhouseInsertJsonEachRow, toClickHouseDateTime } = await import("../shared/clickhouse");
    const { allocateArrivalSeq, releaseArrivalSeq } = await import("../ingest/arrival-seq");
    forgetOldestPosition();
    const tag = Date.now().toString(36);
    const before = arrivalSeqSettled();
    const seq = await allocateArrivalSeq(3);
    const ts = toClickHouseDateTime(new Date().toISOString());
    await clickhouseInsertJsonEachRow(
      [
        { id: `deploy-api-${tag}`, service: "api", kind: "deploy", title: "v1" },
        { id: `deploy-billing-${tag}`, service: "billing", kind: "deploy", title: "v2" },
        { id: `note-${tag}`, service: "", kind: "note", title: "no service" },
      ]
        .map((m, i) => JSON.stringify({ tenant_id: "default", ts, attrs: {}, end_ts: null, toposcope: "here", seq: seq.from + i, ...m }))
        .join("\n"),
      "change_marks",
    );
    releaseArrivalSeq(seq);
    const reply = await readFeed({ id: "f_test", q: "service:api level:error", after: before });
    const ids = reply.marks.map((m) => m.id).filter((id) => id.endsWith(tag));
    // billing is ruled out by a plain mismatch; a mark with no service never is; level:error does not apply.
    expect(ids.sort()).toEqual([`deploy-api-${tag}`, `note-${tag}`].sort());
    expect(reply.marks.find((m) => m.id === `deploy-api-${tag}`)?.toposcope).toBe("here");
  });
});
