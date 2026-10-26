import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getAlert, parseTargets, recordEvalAttempt, recordWebhookAttempt, type AlertRule } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import type { SavedSearch } from "../control/saved-searches";
import type { WebhookOutcome } from "./delivery";
import { callUrls, passSearchMonitor, type SearchMonitorDeps } from "./monitor";
import { monitorHistory } from "./monitor-store";
import type { WebhookPayload } from "./payload";
import type { AlertSeries } from "./series";

const minute = 60_000;
const t0 = Date.parse("2026-10-20T10:41:00.000Z");

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
    ...over,
  };
  const cols = Object.keys(row);
  db.query(`INSERT INTO alert_rules (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
  return row.id as string;
}

/** A monitor, a series to read and a webhook to call, with the clock in the test's hand. */
function rig(db: Database, id = "mon-1", failing: string[] = []) {
  const reading: { value: number; refused: boolean; throws: boolean } = { value: 0, refused: false, throws: false };
  const sent: Array<{ at: number; body: string; json: Record<string, unknown> | null; contentType: string }> = [];
  const calls: string[] = [];
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
    post: async (url: string, payload: WebhookPayload): Promise<WebhookOutcome> => {
      calls.push(url);
      if (failing.includes(url)) {
        return { ok: false, status: "503", error: "Service Unavailable" };
      }
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
    calls,
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


describe("several delivery targets (#280)", () => {
  test("targets resolve: default follows Settings, duplicates drop, five at most", () => {
    const defaultWebhook = () => "https://ntfy.sh/ops";
    expect(callUrls({ webhook_url: "https://a.example/x", webhook_urls: null }, { defaultWebhook })).toEqual(["https://a.example/x"]);
    expect(callUrls({ webhook_url: "", webhook_urls: null }, { defaultWebhook })).toEqual(["https://ntfy.sh/ops"]);
    expect(callUrls({ webhook_url: "https://a.example/x", webhook_urls: ["default", "https://hooks.slack.com/x", "https://ntfy.sh/ops"] }, { defaultWebhook })).toEqual([
      "https://ntfy.sh/ops",
      "https://hooks.slack.com/x",
    ]);
    expect(callUrls({ webhook_url: "", webhook_urls: ["default"] }, { defaultWebhook: () => null })).toEqual([]);
    expect(parseTargets(["default", "https://a.example/x"])).toEqual(["default", "https://a.example/x"]);
    expect(parseTargets([])).toEqual({ error: "webhook_urls is a list of 1 to 5 targets" });
    expect(parseTargets(["ftp://x"])).toEqual({ error: "each of webhook_urls is an http(s) URL, or default for the webhook in Settings" });
    expect(parseTargets(new Array(6).fill(0).map((_, i) => `https://h${i}.example`))).toEqual({ error: "a monitor calls 5 targets at most" });
  });

  test("an open call goes to every target, each its own record; one taking it is enough", async () => {
    const db = freshDb();
    addRule(db, { webhook_urls: JSON.stringify(["https://a.example/hook", "https://hooks.slack.com/services/x"]) });
    const m = rig(db, "mon-1", ["https://a.example/hook"]);
    await m.at(0, 60);
    expect(m.calls).toEqual(["https://a.example/hook", "https://hooks.slack.com/services/x"]);
    const history = monitorHistory("mon-1", 10, db);
    expect(history[0]!.open_call).toBe("sent");
    expect(history[0]!.calls.filter((c) => c.what === "open").map((c) => c.ok)).toEqual([false, true]);
    // Taken once: the failed target is not called again on the next pass.
    await m.at(1, 60);
    expect(m.calls.length).toBe(2);
  });

});

import { beforeAll } from "bun:test";
let api: Record<string, unknown>;
beforeAll(() => {
  // A child process keeps this SQLite out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { getDb } = await import(root + "/control/index.ts");
    const { readMonitorFields, insertMonitor, getAlert } = await import(root + "/control/alerts.ts");
    getDb().query("INSERT INTO saved_searches (id, name, query, range, agg, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("rows", "Errors", "level:error", "5m", null, 1);
    const base = { name: "x", threshold: 2, saved_search_id: "rows" };
    const both = readMonitorFields({ ...base, webhook_urls: ["default", "https://hooks.slack.com/services/x"] }, null);
    const onlyDefault = readMonitorFields({ ...base, webhook_urls: ["default"] }, null);
    const none = readMonitorFields({ ...base }, null);
    const made = getAlert(insertMonitor(both).id);
    console.log(JSON.stringify({ both: both.webhook_url, onlyDefault: onlyDefault.webhook_url, none, stored: made.webhook_urls }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env, SQLITE_PATH: ":memory:" }, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  api = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

describe("POST /api/alert-rules with webhook_urls (#280)", () => {
  test("the first URL is webhook_url; default alone needs none; neither is refused", () => {
    expect(api.both).toBe("https://hooks.slack.com/services/x");
    expect(api.stored).toEqual(["default", "https://hooks.slack.com/services/x"]);
    expect(api.onlyDefault).toBe("");
    expect(api.none).toEqual({ error: "webhook_url must be http(s)", status: 400 });
  });
});
