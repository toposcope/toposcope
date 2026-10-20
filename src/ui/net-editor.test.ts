import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitorRail } from "./components/monitor-rail";
import { WatchView } from "./components/watch-view";
import { addLine, editorLines, goodLines, setTimeLimit, timeLine } from "./http-editor";
import {
  nameFromTarget,
  netModeOf,
  netSourceOf,
  netTimingBar,
  netTimingWords,
  offeredCertName,
  tlsWords,
} from "./net-editor";
import type { MonitorView } from "./types";
import { laneKind, laneReadout, openCardLine, watchFilters } from "./watch";

const now = Date.parse("2026-10-20T11:03:00.000Z");
const day = 24 * 60 * 60_000;

describe("the TCP · certificate editor (#180, as 18r)", () => {
  test("its select is the protocol: TCP, or a certificate over TLS or STARTTLS", () => {
    expect(netSourceOf("tcp")).toEqual({ source: "tcp", starttls: null });
    expect(netSourceOf("tls")).toEqual({ source: "cert", starttls: null });
    expect(netSourceOf("smtp")).toEqual({ source: "cert", starttls: "smtp" });
    expect(netModeOf("cert", "imap")).toBe("imap");
    expect(netModeOf("cert", null)).toBe("tls");
    expect(netModeOf("tcp", null)).toBe("tcp");
  });

  test("a name to start from: the host's first label and its port, or its certificate (18x)", () => {
    expect(nameFromTarget("db.internal:5432", "tcp")).toBe("db:5432");
    expect(nameFromTarget("10.0.0.5:6379", "tcp")).toBe("10.0.0.5:6379");
    expect(nameFromTarget("smtp.agental.dev:587", "cert")).toBe("smtp certificate");
    expect(nameFromTarget("10.0.0.5:993", "cert")).toBe("10.0.0.5 certificate");
    expect(nameFromTarget("no port", "tcp")).toBe("");
  });

  test("each line is read as its monitor's: a TCP line on a TCP monitor, a cert line on a certificate one", () => {
    expect(editorLines("connected\nstatus == 200\ntime < 200ms   warn", "tcp").map((r) => [r.line?.text ?? null, r.error])).toEqual([
      ["connected", null],
      [null, "not a TCP condition: connected, time < 200ms"],
      ["time < 200ms", null],
    ]);
    expect(goodLines("cert > 14d\ncert name == smtp.agental.dev", "cert")).toHaveLength(2);
    expect(addLine("cert > 14d", "cert name == smtp.agental.dev", "cert")).toBe("cert > 14d\ncert name == smtp.agental.dev");
    // A line the monitor does not read is not added.
    expect(addLine("", "cert > 14d", "tcp")).toBe("");
    expect(addLine("cert > 14d", "connected", "cert")).toBe("cert > 14d\nconnected");
    expect(timeLine("connected\ntime < 200ms", "tcp")).toEqual({ index: 1, ms: 200, level: "fail" });
    expect(setTimeLimit("connected\ntime < 200ms   warn", 412, "tcp")).toBe("connected\ntime < 410ms   warn");
  });

  test("where the time went: dns and connect, then tls with any STARTTLS before it (18x)", () => {
    const tcp = { dns: 3, connect: 14, starttls: null, tls: null, total: 17 };
    expect(netTimingWords(tcp)).toBe("dns 3 · connect 14");
    expect(netTimingBar(tcp, 200).segments.map((s) => s.id)).toEqual(["dns", "connect"]);
    expect(netTimingBar(tcp, 200).marker).toBeCloseTo(1 / 1.1);
    const mail = { dns: 1, connect: 20, starttls: 6, tls: 41, total: 68 };
    expect(netTimingWords(mail)).toBe("dns 1 · connect 20 · tls 47");
    expect(netTimingBar(mail, null).segments.map((s) => [s.id, s.ms])).toEqual([
      ["dns", 1],
      ["connect", 20],
      ["tls", 47],
    ]);
    expect(tlsWords("TLS 1.3", "smtp")).toBe("TLS 1.3 via STARTTLS");
    expect(tlsWords("TLS 1.2", null)).toBe("TLS 1.2");
  });

  test("a certificate offers its own name", () => {
    expect(offeredCertName({ subject: "smtp.agental.dev", names: ["smtp.agental.dev"] }, "10.0.0.5:587")).toBe("cert name == smtp.agental.dev");
    expect(offeredCertName({ subject: "", names: ["*.agental.dev"] }, "smtp.agental.dev:587")).toBe("cert name == *.agental.dev");
    expect(offeredCertName({ subject: "Some Org CA", names: [] }, "smtp.agental.dev:587")).toBe("cert name == smtp.agental.dev");
  });
});

const netMonitor = (over: Partial<MonitorView> = {}): MonitorView => ({
  id: "m-db",
  name: "db port",
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
  source: "tcp",
  state: "ok",
  remind_every: "4h",
  last_result: "ok",
  saved: null,
  open: null,
  net: {
    target: "db.internal:5432",
    starttls: null,
    every: "30s",
    every_ms: 30_000,
    conditions: "connected\ntime < 200ms   warn",
    fail_after: 2,
    fails_in_row: 0,
    next_run_at: now + 20_000,
    last_run: { at: now - 10_000, result: "ok", connected: true, duration_ms: 4, line: null, why: null, cert_valid_to: null, cert_subject: null },
  },
  ...over,
});

const certMonitor = netMonitor({
  id: "m-mail",
  name: "mail certificate",
  source: "cert",
  net: {
    target: "smtp.agental.dev:587",
    starttls: "smtp",
    every: "1h",
    every_ms: 60 * 60_000,
    conditions: "cert > 14d",
    fail_after: 2,
    fails_in_row: 0,
    next_run_at: now + 60_000,
    last_run: {
      at: now - 60_000,
      result: "ok",
      connected: true,
      duration_ms: 68,
      line: null,
      why: null,
      cert_valid_to: new Date(now + 61 * day).toISOString(),
      cert_subject: "smtp.agental.dev",
    },
  },
});

describe("TCP and certificate monitors on Watch (18c)", () => {
  test("a lane says what it is and its pace (18y); a TCP lane reads its time, a certificate lane its days left", () => {
    expect(laneKind(netMonitor())).toBe("tcp · 30s · 2 conditions");
    expect(laneReadout(netMonitor(), now, 0)).toEqual({ badge: "ok", tone: "sec", text: "4ms" });
    expect(laneKind(certMonitor)).toBe("certificate · SMTP · 1h");
    expect(laneKind(netMonitor({ source: "cert", net: { ...certMonitor.net!, starttls: null } }))).toBe("certificate · TLS · 1h");
    expect(laneReadout(certMonitor, now, 0)).toEqual({ badge: "ok", tone: "sec", text: "61d left" });
    const none = netMonitor({ net: { ...netMonitor().net!, conditions: "" } });
    expect(laneKind(none)).toBe("tcp · 30s · connects");
    expect(watchFilters([netMonitor(), certMonitor]).map((f) => `${f.label} ${f.n}`)).toEqual(["All 2", "TCP 1", "Certificate 1"]);
  });

  test("a port that refuses says so, and its open card says why", () => {
    const refused = netMonitor({
      net: {
        ...netMonitor().net!,
        last_run: { ...netMonitor().net!.last_run!, result: "fail", connected: false, line: "connected", why: "connect ECONNREFUSED" },
      },
    });
    expect(laneReadout(refused, now, 0)).toEqual({ badge: "fail", tone: "amber", text: "no connection" });
    expect(openCardLine(refused)).toBe("tcp · db.internal:5432 · connect ECONNREFUSED");
    expect(openCardLine(certMonitor)).toBe("certificate · SMTP smtp.agental.dev:587");
  });

  test("Watch draws their lanes", () => {
    const html = renderToStaticMarkup(
      createElement(WatchView, {
        data: { now, from: new Date(now - day).toISOString(), to: new Date(now).toISOString(), monitors: [netMonitor(), certMonitor], stretches: [], sent: [], results: [], link: false },
        canCreate: true,
        range: "24h",
        onRange: () => {},
        filter: "all",
        onFilter: () => {},
        marks: [],
        onNew: () => {},
        onOpen: () => {},
      }),
    );
    expect(html).toContain("tcp · 30s · 2 conditions");
    expect(html).toContain("certificate · SMTP · 1h");
    expect(html).toContain("61d left");
  });

  test("the rail beside its hunt says what it checks and how it last ran", () => {
    const html = renderToStaticMarkup(
      createElement(MonitorRail, {
        monitor: certMonitor,
        nowMs: now,
        onClose: () => undefined,
        onEdit: () => undefined,
        onPause: () => undefined,
        onSilence: () => undefined,
      }),
    );
    expect(html).toContain("SMTP smtp.agental.dev:587");
    expect(html).toContain("every 1h · opens after 2 failed runs");
    expect(html).toContain("11:02 · ok · 68ms");
    expect(html).not.toContain(">search<");
  });
});
