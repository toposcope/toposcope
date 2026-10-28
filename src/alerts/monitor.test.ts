import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAlert, recordEvalAttempt, recordWebhookAttempt, type AlertRule } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import type { SavedSearch } from "../control/saved-searches";
import type { WebhookOutcome } from "./delivery";
import { passSearchMonitor, type SearchMonitorDeps } from "./monitor";
import { closeByEdit, monitorHistory, openStretch, pruneStretches } from "./monitor-store";
import type { WebhookPayload } from "./payload";
import type { AlertSeries } from "./series";

const minute = 60_000;
const t0 = Date.parse("2026-10-20T10:41:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const saved = {
  id: "saved-1",
  name: "api errors",
  query: "service:api level:error",
  range: "15m",
  from_ts: null,
  to_ts: null,
  agg: null,
} as SavedSearch;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(path = ":memory:"): Database {
  const db = new Database(path);
  migrateControlDb(db);
  return db;
}

function addRule(db: Database, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: "mon-1",
    name: "api errors",
    query: saved.query,
    webhook_url: "https://hooks.example.com/page",
    saved_search_id: saved.id,
    threshold: 50,
    enabled: 1,
    created_at: t0 - 60 * minute,
    kind: "threshold",
    body_kind: "default",
    body_template: null,
    source: "search",
    remind_every: "window",
    resolved_body: null,
    silenced_until: null,
    // Every monitor names its service (#335); one that does not is removed at the next start.
    service: "api",
    ...over,
  };
  const cols = Object.keys(row);
  db.query(`INSERT INTO alert_rules (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
  return row.id as string;
}

/** A monitor, a series to read and a webhook to call, with the clock in the test's hand. */
function rig(db: Database, id = "mon-1") {
  const reading: { value: number; refused: boolean; throws: boolean } = { value: 0, refused: false, throws: false };
  const sent: Array<{ at: number; body: string; json: Record<string, unknown> | null; contentType: string }> = [];
  const answer: { ok: boolean } = { ok: true };
  let clock = t0;
  const deps: SearchMonitorDeps = {
    db,
    read: async (): Promise<AlertSeries> => {
      if (reading.throws) {
        throw new Error("ClickHouse is down");
      }
      return reading.refused
        ? { expr: null, count: 0, value: 0, refused: true, reason: "read budget" }
        : { expr: null, count: reading.value, value: reading.value, refused: false };
    },
    post: async (_url: string, payload: WebhookPayload): Promise<WebhookOutcome> => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(payload.body) as Record<string, unknown>;
      } catch {
        json = null;
      }
      sent.push({ at: clock, body: payload.body, json, contentType: payload.contentType });
      return answer.ok ? { ok: true, status: "200", error: null } : { ok: false, status: "503", error: "Service Unavailable" };
    },
    publicUrl: () => null,
    recordWebhook: recordWebhookAttempt,
    recordEval: recordEvalAttempt,
  };
  return {
    reading,
    sent,
    answer,
    rule: (): AlertRule => getAlert(id, db)!,
    /** One pass at t0 + `minutes`, reading `value` (or a refusal). */
    async at(minutes: number, value?: number | "refused" | "error") {
      clock = t0 + minutes * minute;
      reading.refused = value === "refused";
      reading.throws = value === "error";
      if (typeof value === "number") {
        reading.value = value;
      }
      await passSearchMonitor(getAlert(id, db)!, saved, clock, deps);
    },
  };
}

describe("a search monitor opens, reminds and resolves (#175)", () => {
  test("with a 15m window it opens once, reminds every window, and sends one resolved call", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    await m.at(0, 57);
    expect(m.rule().state).toBe("open");
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open"]);
    for (let i = 1; i < 15; i++) {
      await m.at(i, 60);
    }
    expect(m.sent).toHaveLength(1);
    await m.at(15, 61);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "reminder"]);
    await m.at(16, 12);
    expect(m.rule().state).toBe("ok");
    await m.at(17, 3);
    await m.at(18, 0);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "reminder", "resolved"]);
    const [open, reminder, resolved] = m.sent.map((s) => s.json!);
    expect(open).toMatchObject({ state: "open", opened_at: iso(t0), resolved_at: null, value: 57, count: 57 });
    expect(reminder).toMatchObject({ state: "reminder", opened_at: iso(t0), resolved_at: null, value: 61 });
    expect(resolved).toMatchObject({
      state: "resolved",
      opened_at: iso(t0),
      resolved_at: iso(t0 + 16 * minute),
      value: 12,
      fired_at: iso(t0 + 16 * minute),
    });
    const [stretch] = monitorHistory("mon-1", 200, db);
    expect(stretch).toMatchObject({
      opened_at: t0,
      resolved_at: t0 + 16 * minute,
      closed_by: "ok",
      open_message: "Count 57 ≥ 50",
      open_call: "sent",
      resolved_call: "sent",
    });
    expect(stretch!.calls.map((c) => [c.what, c.status, c.at])).toEqual([
      ["open", "200", t0],
      ["reminder", "200", t0 + 15 * minute],
      ["resolved", "200", t0 + 16 * minute],
    ]);
  });

  test("a new monitor reminds every 4h, not every window", async () => {
    const db = freshDb();
    addRule(db, { remind_every: "4h" });
    const m = rig(db);
    await m.at(0, 57);
    await m.at(15, 57);
    await m.at(30, 57);
    expect(m.sent).toHaveLength(1);
    await m.at(239, 57);
    expect(m.sent).toHaveLength(1);
    await m.at(240, 57);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "reminder"]);
  });

  test("reminders off: it opens and resolves, and says nothing between", async () => {
    const db = freshDb();
    addRule(db, { remind_every: "off" });
    const m = rig(db);
    await m.at(0, 57);
    for (let i = 1; i <= 600; i += 30) {
      await m.at(i, 57);
    }
    await m.at(601, 0);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "resolved"]);
  });

  test("a restart in between keeps it open: no second open call, one resolved call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toposcope-monitor-"));
    dirs.push(dir);
    const path = join(dir, "control.sqlite");
    const before = freshDb(path);
    addRule(before);
    const first = rig(before);
    await first.at(0, 57);
    expect(first.sent).toHaveLength(1);
    before.close();

    const after = freshDb(path);
    const second = rig(after);
    expect(second.rule().state).toBe("open");
    expect(openStretch("mon-1", after)?.opened_at).toBe(t0);
    await second.at(3, 57);
    expect(second.sent).toHaveLength(0);
    await second.at(4, 0);
    expect(second.sent.map((s) => s.json?.state)).toEqual(["resolved"]);
    expect(second.sent[0]!.json).toMatchObject({ opened_at: iso(t0), resolved_at: iso(t0 + 4 * minute) });
    after.close();
  });

  test("a refused or failed reading neither opens nor resolves it", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    await m.at(0, "refused");
    expect(m.rule().state).toBe("ok");
    expect(m.rule().last_status).toBe("refused");
    expect(monitorHistory("mon-1", 200, db)).toHaveLength(0);
    await m.at(1, 57);
    expect(m.rule().state).toBe("open");
    await m.at(2, "refused");
    await m.at(3, "error");
    expect(m.rule().state).toBe("open");
    expect(m.rule().last_status).toBe("error");
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open"]);
    expect(openStretch("mon-1", db)?.last_value).toBe(57);
    await m.at(4, 0);
    expect(m.rule().state).toBe("ok");
    expect(m.rule().last_status).toBe("200");
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "resolved"]);
  });

  test("silencing stops its calls but not its record, and nothing is made up after", async () => {
    const db = freshDb();
    addRule(db, { silenced_until: t0 + 30 * minute });
    const m = rig(db);
    await m.at(0, 57);
    await m.at(15, 57);
    expect(m.sent).toHaveLength(0);
    expect(m.rule().state).toBe("open");
    await m.at(20, 0);
    expect(m.rule().state).toBe("ok");
    await m.at(21, 57);
    await m.at(31, 57);
    expect(m.sent).toHaveLength(0);
    const [second, first] = monitorHistory("mon-1", 200, db);
    expect(first).toMatchObject({ opened_at: t0, resolved_at: t0 + 20 * minute, open_call: "silenced", resolved_call: "silenced" });
    expect(first!.calls.map((c) => [c.what, c.status])).toEqual([
      ["open", "silenced"],
      ["reminder", "silenced"],
      ["resolved", "silenced"],
    ]);
    expect(second).toMatchObject({ opened_at: t0 + 21 * minute, resolved_at: null, open_call: "silenced" });
    // The silence ended at 30m: the next call is the reminder when it is due, not the open it missed.
    await m.at(36, 57);
    expect(m.sent.map((s) => [s.json?.state, s.at])).toEqual([["reminder", t0 + 36 * minute]]);
  });

  test("a failed open call is tried each pass for an hour, then shown failed on its stretch", async () => {
    const db = freshDb();
    addRule(db, { remind_every: "off" });
    const m = rig(db);
    m.answer.ok = false;
    for (let i = 0; i < 60; i++) {
      await m.at(i, 57);
    }
    expect(m.sent).toHaveLength(60);
    expect(m.rule().consecutive_failures).toBe(60);
    await m.at(60, 57);
    await m.at(61, 57);
    expect(m.sent).toHaveLength(60);
    expect(openStretch("mon-1", db)?.open_call).toBe("failed");
  });

  test("a failed open call that goes through on a later pass is sent once", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    m.answer.ok = false;
    await m.at(0, 57);
    await m.at(1, 57);
    m.answer.ok = true;
    await m.at(2, 57);
    await m.at(3, 57);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "open", "open"]);
    expect(openStretch("mon-1", db)?.open_call).toBe("sent");
    // The window counts from the call that went through.
    await m.at(16, 57);
    expect(m.sent).toHaveLength(3);
    await m.at(17, 57);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open", "open", "open", "reminder"]);
  });

  test("its own text body sends no resolved call until it has a resolved body", async () => {
    const db = freshDb();
    addRule(db, { body_kind: "text", body_template: "{{alert.name}} {{state}}: {{message}}" });
    const m = rig(db);
    await m.at(0, 57);
    await m.at(1, 0);
    expect(m.sent.map((s) => s.body)).toEqual(["api errors open: Count 57 ≥ 50"]);
    expect(monitorHistory("mon-1", 200, db)[0]).toMatchObject({ resolved_call: "none" });

    db.query("UPDATE alert_rules SET resolved_body = ? WHERE id = 'mon-1'").run(
      "{{alert.name}} {{state}} after {{duration}} ({{opened_at}} to {{resolved_at}}); it opened on {{message}}",
    );
    await m.at(2, 57);
    await m.at(24, 3);
    expect(m.sent.at(-1)!.body).toBe(
      `api errors resolved after 22m (${iso(t0 + 2 * minute)} to ${iso(t0 + 24 * minute)}); it opened on Count 57 ≥ 50`,
    );
    expect(m.sent.at(-1)!.contentType).toStartWith("text/plain");
  });

  test("Slack says it resolved and how long it lasted", async () => {
    const db = freshDb();
    addRule(db, { webhook_url: "https://hooks.slack.com/services/T/B/x" });
    const m = rig(db);
    await m.at(0, 57);
    await m.at(479, 3);
    const resolved = m.sent.at(-1)!.json as { text: string; blocks: Array<{ text: { text: string } }> };
    expect(resolved.text).toBe("Toposcope: api errors resolved after 7h 59m — Count 3 < 50");
    expect(resolved.blocks[0]!.text.text).toStartWith("*api errors* resolved after 7h 59m\n");
  });

  test("an edit while open closes it without a call", async () => {
    const db = freshDb();
    addRule(db);
    const m = rig(db);
    await m.at(0, 57);
    closeByEdit("mon-1", t0 + 5 * minute, db);
    expect(m.rule().state).toBe("ok");
    await m.at(6, 0);
    expect(m.sent.map((s) => s.json?.state)).toEqual(["open"]);
    expect(monitorHistory("mon-1", 200, db)[0]).toMatchObject({
      closed_by: "edit",
      resolved_at: t0 + 5 * minute,
      resolved_call: "none",
    });
  });

  test("the last 200 stretches are kept, with their calls", async () => {
    const db = freshDb();
    addRule(db, { remind_every: "off" });
    const m = rig(db);
    for (let i = 0; i < 205; i++) {
      await m.at(2 * i, 57);
      await m.at(2 * i + 1, 0);
    }
    pruneStretches("mon-1", db);
    const kept = monitorHistory("mon-1", 1000, db);
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)!.opened_at).toBe(t0 + 10 * minute);
    const calls = db.query("SELECT count(*) AS n FROM monitor_calls WHERE monitor_id = 'mon-1'").get() as { n: number };
    expect(calls.n).toBe(400);
  });
});

describe("an upgrade from 0.5 (#175, #335)", () => {
  /** alert_rules as 0.5.7 left it. */
  function db057(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE alert_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, webhook_url TEXT, created_at INTEGER NOT NULL,
      saved_search_id TEXT, threshold REAL NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER, last_attempt_at INTEGER, last_status TEXT, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, silenced_until INTEGER,
      kind TEXT NOT NULL DEFAULT 'threshold', last_mark TEXT, body_kind TEXT NOT NULL DEFAULT 'default', body_template TEXT
    )`);
    db.run(
      `INSERT INTO alert_rules (id, name, query, webhook_url, created_at, saved_search_id, threshold, last_fired_at)
       VALUES ('mon-1', 'api errors', 'service:api level:error', 'https://hooks.example.com/page', 0, 'saved-1', 50, ${t0 - 90 * minute})`,
    );
    db.run(
      `INSERT INTO alert_rules (id, name, query, webhook_url, created_at, saved_search_id, threshold, kind)
       VALUES ('mon-2', 'after a deploy', 'level:error', 'https://hooks.example.com/page', 0, 'saved-1', 1, 'first_seen')`,
    );
    return db;
  }

  test("its alerts name no service, so they are not kept", () => {
    const db = db057();
    migrateControlDb(db);
    expect(getAlert("mon-1", db)).toBeNull();
    expect(getAlert("mon-2", db)).toBeNull();
  });
});
