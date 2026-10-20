import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitorRail } from "./components/monitor-rail";
import {
  addLine,
  editorLines,
  goodLines,
  headerContains,
  headersText,
  jsonRows,
  nameFromUrl,
  offeredLines,
  offeredTimeLimit,
  readHeadersText,
  removeLine,
  setLineLevel,
  setTimeLimit,
  timeLine,
  timingBar,
  timingWords,
  webhookShort,
} from "./http-editor";
import type { MonitorView } from "./types";
import { laneKind, laneReadout, openCardLine, watchFilters } from "./watch";

const lines18r = 'status == 200\n$.db == "ok"\ntime < 300ms   warn\ncert > 14d';

describe("the stored lines (18r)", () => {
  test("each written line reads back, a bad one with why", () => {
    const rows = editorLines('status == 200\n\nbody has "ok"\ntime < 300ms   warn');
    expect(rows.map((r) => [r.index, r.line?.text ?? null, r.line?.level ?? null, r.error !== null])).toEqual([
      [0, "status == 200", "fail", false],
      [2, null, null, true],
      [3, "time < 300ms", "warn", false],
    ]);
    expect(goodLines(lines18r)).toHaveLength(4);
  });

  test("a picked value is a new last line, never twice", () => {
    let t = addLine("", "status == 200");
    t = addLine(t, '$.db == "ok"');
    t = addLine(t, "status  ==  200");
    expect(t).toBe('status == 200\n$.db == "ok"');
  });

  test("fail | warn rewrites the line's end; × takes the line out", () => {
    expect(setLineLevel(lines18r, 0, "warn")).toStartWith("status == 200   warn\n");
    expect(setLineLevel(lines18r, 2, "fail").split("\n")[2]).toBe("time < 300ms");
    expect(removeLine(lines18r, 1)).toBe("status == 200\ntime < 300ms   warn\ncert > 14d");
  });

  test("the time marker drags the time line's limit, keeping it a warn", () => {
    expect(timeLine(lines18r)).toEqual({ index: 2, ms: 300, level: "warn" });
    expect(setTimeLimit(lines18r, 448).split("\n")[2]).toBe("time < 450ms   warn");
    expect(setTimeLimit("status == 200", 612)).toBe("status == 200\ntime < 610ms");
    expect(offeredTimeLimit(412)).toBe(650);
  });

  test("the timing bar spans the run, or the limit when it is longer", () => {
    const t = { dns: 4, connect: 18, tls: 41, wait: 340, body: 9, total: 412 };
    const bar = timingBar(t, 300);
    expect(bar.spanMs).toBe(412);
    expect(bar.marker).toBeCloseTo(300 / 412, 5);
    expect(bar.segments.map((s) => s.id)).toEqual(["dns", "connect", "tls", "wait", "body"]);
    expect(timingBar(t, 1000).spanMs).toBe(1100);
    expect(timingWords(t)).toBe("dns 4 · connect 18 · tls 41 · wait 340 · body 9");
    expect(timingWords({ ...t, tls: null })).toBe("dns 4 · connect 18 · wait 340 · body 9");
  });

  test("a JSON body is rows; a value offers its line, a number == < and >", () => {
    const rows = jsonRows({ db: "ok", queue: { depth: 3 }, version: "0.9.3" });
    expect(rows.map((r) => [r.depth, r.key, r.brace, r.value, r.comma])).toEqual([
      [0, null, "{", undefined, false],
      [1, "db", null, "ok", true],
      [1, "queue", "{", undefined, false],
      [2, "depth", null, 3, false],
      [1, null, "}", undefined, true],
      [1, "version", null, "0.9.3", false],
      [0, null, "}", undefined, false],
    ]);
    expect(offeredLines(rows[1]!.path!, "ok")).toEqual(['$.db == "ok"']);
    expect(offeredLines(rows[3]!.path!, 3)).toEqual(["$.queue.depth == 3", "$.queue.depth < 3", "$.queue.depth > 3"]);
    expect(offeredLines(jsonRows([{ id: "a" }])[2]!.path!, "a")).toEqual(['$[0].id == "a"']);
  });

  test("a header offers its value up to a ;", () => {
    expect(headerContains("Content-Type", "application/json; charset=utf-8")).toBe(
      "header content-type contains application/json",
    );
  });

  test("request headers: a stored value comes back as •••• and is kept as null", () => {
    expect(headersText(["Authorization"])).toBe("Authorization: ••••");
    expect(readHeadersText("Authorization: ••••\nX-Env: prod")).toEqual({
      ok: true,
      headers: { Authorization: null, "X-Env": "prod" },
    });
    expect(readHeadersText("no colon")).toMatchObject({ ok: false });
    expect(readHeadersText("Host: x")).toEqual({ ok: false, error: "header Host is set by the request itself" });
  });

  test("names and addresses, short", () => {
    expect(nameFromUrl("https://api.agental.dev/health")).toBe("api /health");
    expect(nameFromUrl("http://127.0.0.1:8080/")).toBe("127.0.0.1:8080");
    expect(webhookShort("https://ntfy.sh/agental-ops")).toBe("ntfy.sh/agental-ops");
  });
});

const now = Date.parse("2026-10-20T11:03:00.000Z");

const httpMonitor = (over: Partial<MonitorView> = {}): MonitorView => ({
  id: "m-health",
  name: "api /health",
  kind: "threshold",
  last_mark: null,
  body_kind: "default",
  body_template: null,
  saved_search_id: null,
  threshold: 1,
  webhook_url: "https://ntfy.sh/agental-ops",
  last_fired_at: null,
  last_attempt_at: null,
  last_status: null,
  last_error: null,
  consecutive_failures: 0,
  silenced_until: null,
  enabled: 1,
  source: "http",
  state: "ok",
  remind_every: "4h",
  last_result: "ok",
  saved: null,
  open: null,
  http: {
    url: "https://api.agental.dev/health",
    method: "GET",
    body: null,
    headers: ["Authorization"],
    every: "30s",
    every_ms: 30_000,
    conditions: 'status == 200\n$.db == "ok"\ntime < 300ms   warn',
    fail_after: 2,
    fails_in_row: 0,
    next_run_at: now + 20_000,
    last_run: { at: now - 10_000, result: "ok", status: 200, duration_ms: 182, line: null, why: null, cert_valid_to: null },
  },
  ...over,
});

describe("an HTTP(S) monitor on Watch (18c)", () => {
  test("its lane says http, its pace and its conditions, and reads its last time", () => {
    const m = httpMonitor();
    expect(laneKind(m)).toBe("http · 30s · 3 conditions");
    expect(laneReadout(m, now, 0)).toEqual({ badge: "ok", tone: "sec", text: "182ms" });
    expect(watchFilters([m]).map((f) => `${f.label} ${f.n}`)).toEqual(["All 1", "HTTP 1"]);
  });

  test("a certificate-only monitor reads days left", () => {
    const m = httpMonitor({
      name: "agental.dev certificate",
      http: {
        ...httpMonitor().http!,
        every: "1h",
        conditions: "cert > 14d",
        last_run: { at: now, result: "ok", status: 200, duration_ms: 90, line: null, why: null, cert_valid_to: new Date(now + 61 * 86_400_000).toISOString() },
      },
    });
    expect(laneKind(m)).toBe("http · 1h · cert > 14d");
    expect(laneReadout(m, now, 0).text).toBe("61d left");
  });

  test("a warn is amber; a fail before it opens is amber too, open is red", () => {
    const warn = httpMonitor({ http: { ...httpMonitor().http!, last_run: { ...httpMonitor().http!.last_run!, result: "warn", duration_ms: 412 } } });
    expect(laneReadout(warn, now, 0)).toEqual({ badge: "warn", tone: "amber", text: "412ms" });
    const fail = httpMonitor({
      http: { ...httpMonitor().http!, last_run: { ...httpMonitor().http!.last_run!, result: "fail", status: null, why: "connect ECONNREFUSED" } },
    });
    expect(laneReadout(fail, now, 0)).toEqual({ badge: "fail", tone: "amber", text: "no response" });
    expect(openCardLine(fail)).toBe("http · GET https://api.agental.dev/health · connect ECONNREFUSED");
  });

  test("the rail beside its hunt says what it checks and how it last ran", () => {
    const html = renderToStaticMarkup(
      createElement(MonitorRail, {
        monitor: httpMonitor(),
        nowMs: now,
        onClose: () => undefined,
        onEdit: () => undefined,
        onPause: () => undefined,
        onSilence: () => undefined,
      }),
    );
    expect(html).toContain("GET https://api.agental.dev/health");
    expect(html).toContain("every 30s · opens after 2 failed runs");
    expect(html).toContain("11:02 · ok · 200 in 182ms");
    // Its headers are never printed, not even their names' values.
    expect(html).not.toContain("Bearer");
  });
});
