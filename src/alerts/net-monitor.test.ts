import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeCerts, type Certs } from "../../scripts/http-stands";
import { startNetStands, type NetStands } from "../../scripts/net-stands";
import { getAlert, recordWebhookAttempt } from "../control/alerts";
import { migrateControlDb } from "../control/index";
import type { LogEvent } from "../shared/log-event";
import type { MetricPoint } from "../shared/metric";
import { tickHttpMonitors } from "./http-cron";
import { runNetMonitor, type NetMonitorDeps } from "./net-monitor";
import { runNetRequest } from "./net-request";
import { getNet, insertNet, type NetWrite } from "./net-store";
import { monitorHistory, openStretch, resultsBetween } from "./monitor-store";
import type { WebhookPayload } from "./payload";

let certs: Certs;
let stands: NetStands;

beforeAll(async () => {
  certs = makeCerts(20);
  stands = await startNetStands(certs);
});

afterAll(() => {
  stands.stop();
  certs.cleanup();
});

const t0 = Date.parse("2026-10-20T11:03:00.000Z");

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateControlDb(db);
  return db;
}

function addNet(
  db: Database,
  source: "tcp" | "cert",
  w: Partial<NetWrite> & { target: string },
  over: Record<string, unknown> = {},
): string {
  const row: Record<string, unknown> = {
    id: `${source}-1`,
    name: source === "tcp" ? "db port" : "mail cert",
    query: "",
    webhook_url: "https://hooks.example.com/page",
    saved_search_id: null,
    threshold: 1,
    enabled: 1,
    created_at: t0 - 60_000,
    kind: source,
    body_kind: "default",
    body_template: null,
    source,
    remind_every: "4h",
    resolved_body: null,
    ...over,
  };
  const cols = Object.keys(row);
  db.query(`INSERT INTO alert_rules (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
  insertNet(row.id as string, { starttls: null, every_ms: 30_000, conditions: "", fail_after: 2, ...w }, t0, db);
  return row.id as string;
}

/** A monitor's runs, rows, metrics and calls, with the clock in the test's hand. */
function rig(db: Database) {
  const rows: LogEvent[] = [];
  const metrics: MetricPoint[] = [];
  const calls: Array<{ url: string; json: Record<string, unknown> }> = [];
  const deps: NetMonitorDeps = {
    db,
    connect: (input) => runNetRequest({ ...input, ca: certs.ca }),
    write: async (row, metric) => {
      rows.push(row);
      if (metric) {
        metrics.push(metric);
      }
    },
    post: async (url: string, payload: WebhookPayload) => {
      calls.push({ url, json: JSON.parse(payload.body) as Record<string, unknown> });
      return { ok: true, status: "200", error: null };
    },
    publicUrl: () => "https://logs.example.com",
    recordWebhook: (id, attempt, database) => recordWebhookAttempt(id, attempt, database),
  };
  const run = async (id: string, at: number) => runNetMonitor(getAlert(id, db)!, getNet(id, db)!, at, deps);
  return { rows, metrics, calls, deps, run };
}

describe("a TCP monitor", () => {
  test("on a closed port opens after two runs, and each row says why", async () => {
    const db = freshDb();
    const id = addNet(db, "tcp", { target: stands.closed, conditions: "connected\ntime < 200ms" });
    const r = rig(db);
    await r.run(id, t0);
    expect(getAlert(id, db)!.state).toBe("ok");
    expect(getNet(id, db)!.fails_in_row).toBe(1);
    expect(r.calls).toHaveLength(0);
    await r.run(id, t0 + 30_000);
    expect(getAlert(id, db)!.state).toBe("open");
    expect(openStretch(id, db)!.open_message).toBe("connect ECONNREFUSED");
    expect(r.calls.map((c) => c.json)).toEqual([
      expect.objectContaining({
        alert: { id, name: "db port", source: "tcp" },
        target: stands.closed,
        message: "connect ECONNREFUSED",
        state: "open",
      }),
    ]);
    expect(r.rows.map((row) => [row.level, row.message])).toEqual([
      ["error", "db port fail · connect ECONNREFUSED"],
      ["error", "db port fail · connect ECONNREFUSED"],
    ]);
    expect(r.rows[0]!.attrs).toMatchObject({
      monitor: "db port",
      status: "fail",
      source: "tcp",
      target: stands.closed,
      line: "connected",
      error: "connect ECONNREFUSED",
    });
    expect(r.rows[0]!.host).toBe("127.0.0.1");
    // Nothing answered, so no time is kept as a metric.
    expect(r.metrics).toHaveLength(0);
    expect(getNet(id, db)!.last_run).toMatchObject({ result: "fail", connected: false, line: "connected", why: "connect ECONNREFUSED" });
  });

  test("resolves on the next run that connects", async () => {
    const db = freshDb();
    const id = addNet(db, "tcp", { target: stands.closed, fail_after: 1 });
    const r = rig(db);
    await r.run(id, t0);
    expect(getAlert(id, db)!.state).toBe("open");
    db.query("UPDATE monitor_net SET target = ? WHERE monitor_id = ?").run(stands.open, id);
    const run = await r.run(id, t0 + 30_000);
    expect(run.verdict.result).toBe("ok");
    expect(getAlert(id, db)!.state).toBe("ok");
    expect(r.calls.map((c) => c.json.state)).toEqual(["open", "resolved"]);
    expect(monitorHistory(id, 5, db)[0]).toMatchObject({ opened_at: t0, resolved_at: t0 + 30_000, closed_by: "ok" });
    const ok = r.rows[1]!;
    expect(ok.level).toBe("info");
    expect(ok.message).toMatch(/^db port ok · connected in \d+ms$/);
    expect(r.metrics).toEqual([
      { ts: ok.ts, name: "monitor_duration_ms", value: ok.attrs!.duration_ms as number, labels: { monitor: "db port", source: "tcp" } },
    ]);
  });

  test("each run is a tick on its lane, via tcp", async () => {
    const db = freshDb();
    const id = addNet(db, "tcp", { target: stands.closed });
    const r = rig(db);
    await r.run(id, t0);
    expect(resultsBetween(t0 - 60_000, t0 + 60_000, db).map((x) => [x.monitor_id, x.result, x.via])).toEqual([[id, "fail", "tcp"]]);
  });
});

describe("a certificate monitor", () => {
  test("cert > 30d fails on a certificate with 20 days left, and the row says why", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.tls, conditions: "cert > 30d", fail_after: 1 });
    const r = rig(db);
    const at = Date.now();
    const run = await r.run(id, at);
    expect(run.verdict).toMatchObject({ result: "fail", line: "cert > 30d" });
    expect(run.verdict.why).toMatch(/^certificate expires in (19|20) days$/);
    expect(getAlert(id, db)!.state).toBe("open");
    const row = r.rows[0]!;
    expect(row.message).toBe(`mail cert fail · ${run.verdict.why}`);
    expect(row.attrs).toMatchObject({ source: "cert", target: stands.tls, line: "cert > 30d", "cert.subject": "localhost" });
    expect([19, 20]).toContain(row.attrs!["cert.days_left"] as number);
    expect(getNet(id, db)!.last_run).toMatchObject({ result: "fail", connected: true, cert_subject: "localhost" });
    expect(r.calls[0]!.json).toMatchObject({ alert: { source: "cert" }, starttls: null, message: run.verdict.why });
  });

  test("cert > 14d passes on it, and says how many days are left", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.tls, conditions: "cert > 14d" });
    const r = rig(db);
    const run = await r.run(id, Date.now());
    expect(run.verdict.result).toBe("ok");
    expect(r.rows[0]!.message).toMatch(/^mail cert ok · certificate for localhost, (19|20) days left$/);
  });

  test("STARTTLS on a stand-in SMTP server reads its certificate", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.smtp, starttls: "smtp", conditions: "cert > 14d\ncert name == localhost" });
    const r = rig(db);
    const run = await r.run(id, Date.now());
    expect(run.exchange).toMatchObject({ ok: true, greeting: "220 mail.stand-in ESMTP toposcope" });
    expect(run.verdict.result).toBe("ok");
    expect(r.rows[0]!.attrs).toMatchObject({ starttls: "smtp", "cert.subject": "localhost" });
  });

  test("a mail server that refuses STARTTLS fails, and the row says what it answered", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.smtpNoTls, starttls: "smtp", conditions: "cert > 14d", fail_after: 1 });
    const r = rig(db);
    await r.run(id, Date.now());
    expect(r.rows[0]!.attrs).toMatchObject({ status: "fail", error: "STARTTLS refused: 502 5.5.1 STARTTLS not here" });
    expect(getAlert(id, db)!.state).toBe("open");
  });

  test("a certificate not for its name fails on cert name", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.tls, conditions: "cert name == mail.example.com", fail_after: 1 });
    const r = rig(db);
    const run = await r.run(id, Date.now());
    expect(run.verdict).toMatchObject({
      result: "fail",
      line: "cert name == mail.example.com",
      why: "certificate is for localhost +1, not mail.example.com",
    });
  });

  test("a certificate this node does not trust fails, and says so", async () => {
    const db = freshDb();
    const id = addNet(db, "cert", { target: stands.tls, conditions: "cert > 14d", fail_after: 1 });
    const r = rig(db);
    r.deps.connect = (input) => runNetRequest(input);
    const run = await r.run(id, Date.now());
    expect(run.verdict).toMatchObject({ result: "fail", why: "certificate is not trusted" });
  });
});

describe("the loop", () => {
  test("runs due TCP and certificate monitors beside HTTP(S) ones, each once a tick", async () => {
    const db = freshDb();
    const tcp = addNet(db, "tcp", { target: stands.open });
    const cert = addNet(db, "cert", { target: stands.imap, starttls: "imap" }, { id: "cert-1" });
    const paused = addNet(db, "tcp", { target: stands.open }, { id: "tcp-paused", name: "paused", enabled: 0 });
    const r = rig(db);
    await tickHttpMonitors(t0, { ...r.deps, request: async () => ({ ok: false, error: "unused", timings: { dns: 0, connect: 0, tls: null, wait: 0, body: 0, total: 0 }, cert: null }) });
    expect(getNet(tcp, db)!.next_run_at).toBe(t0 + 30_000);
    expect(getNet(tcp, db)!.last_run).toMatchObject({ at: t0, result: "ok", connected: true });
    expect(getNet(cert, db)!.last_run).toMatchObject({ at: t0, cert_subject: "localhost" });
    expect(getNet(paused, db)!.last_run).toBeNull();
    expect(r.rows).toHaveLength(2);
  });
});
