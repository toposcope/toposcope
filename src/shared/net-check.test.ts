import { describe, expect, test } from "bun:test";
import { parseConditionLine, parseConditions, type ConditionLine } from "./http-check";
import { certCovers, formatNetTarget, judgeNetRun, parseNetTarget, parseStarttls, type NetCertSeen } from "./net-check";

const now = Date.parse("2026-10-20T11:03:00.000Z");
const day = 24 * 60 * 60_000;

function lines(text: string, kind: "tcp" | "cert"): ConditionLine[] {
  const read = parseConditions(text, kind);
  if ("error" in read) {
    throw new Error(read.error);
  }
  return read;
}

function cert(over: Partial<NetCertSeen> = {}): NetCertSeen {
  return {
    subject: "smtp.agental.dev",
    names: ["smtp.agental.dev", "*.mail.agental.dev"],
    issuer: "Let's Encrypt",
    valid_to: new Date(now + 20 * day).toISOString(),
    untrusted: null,
    ...over,
  };
}

describe("parseNetTarget", () => {
  test("a host and a port, an address, an IPv6 address in brackets", () => {
    expect(parseNetTarget("db.internal:5432")).toEqual({ host: "db.internal", port: 5432 });
    expect(parseNetTarget(" 10.0.0.5:6379 ")).toEqual({ host: "10.0.0.5", port: 6379 });
    expect(parseNetTarget("[::1]:993")).toEqual({ host: "::1", port: 993 });
    expect(parseNetTarget("SMTP.Agental.dev:587")).toEqual({ host: "smtp.agental.dev", port: 587 });
    expect(formatNetTarget({ host: "::1", port: 993 })).toBe("[::1]:993");
    expect(formatNetTarget({ host: "db.internal", port: 5432 })).toBe("db.internal:5432");
  });

  test("says why it is not one", () => {
    expect(parseNetTarget("")).toEqual({ error: "target is required: host:port" });
    expect(parseNetTarget("tcp://db:5432")).toEqual({ error: "target is host:port, without a scheme or a path" });
    expect(parseNetTarget("db.internal")).toEqual({ error: "target is host:port: db.internal:5432, or [::1]:993" });
    expect(parseNetTarget("db:0")).toEqual({ error: "the port must be 1 to 65535" });
    expect(parseNetTarget("db:70000")).toEqual({ error: "the port must be 1 to 65535" });
    expect(parseNetTarget("db..x:1")).toEqual({ error: "db..x is not a host name or an address" });
  });
});

describe("parseStarttls", () => {
  test("smtp, imap or pop3; nothing is TLS from the first byte", () => {
    expect(parseStarttls("SMTP")).toBe("smtp");
    expect(parseStarttls("pop3")).toBe("pop3");
    expect(parseStarttls(null)).toBeNull();
    expect(parseStarttls("")).toBeNull();
    expect(parseStarttls("ftp")).toBeUndefined();
  });
});

describe("conditions by monitor", () => {
  test("a TCP monitor reads connected and time", () => {
    expect(parseConditionLine("connected", "tcp")).toEqual({ text: "connected", level: "fail", cond: { what: "connected" } });
    expect(parseConditionLine("time < 200ms   warn", "tcp")).toMatchObject({ level: "warn", cond: { what: "time", ms: 200 } });
    expect(parseConditionLine("status == 200", "tcp")).toEqual({ error: "not a TCP condition: connected, time < 200ms" });
    expect(parseConditionLine("body contains ok", "tcp")).toEqual({ error: "not a TCP condition: connected, time < 200ms" });
    expect(parseConditionLine("cert > 14d", "tcp")).toEqual({ error: "not a TCP condition: connected, time < 200ms" });
  });

  test("a certificate monitor reads cert days and cert name", () => {
    expect(parseConditionLine("cert > 14d", "cert")).toMatchObject({ cond: { what: "cert", op: ">", ms: 14 * day } });
    expect(parseConditionLine("cert name == Mail.Example.com", "cert")).toEqual({
      text: "cert name == Mail.Example.com",
      level: "fail",
      cond: { what: "cert-name", name: "mail.example.com" },
    });
    expect(parseConditionLine('cert name == "*.example.com" warn', "cert")).toMatchObject({ level: "warn", cond: { name: "*.example.com" } });
    expect(parseConditionLine("cert name == not a name", "cert")).toEqual({ error: "cert name needs a host name: cert name == mail.example.com" });
    expect(parseConditionLine("connected", "cert")).toEqual({
      error: "not a certificate condition: cert > 14d, cert name == mail.example.com",
    });
    expect(parseConditionLine("time < 200ms", "cert")).toMatchObject({ error: expect.stringContaining("not a certificate condition") });
  });

  test("an HTTP(S) monitor's lines are as they were", () => {
    expect(parseConditionLine("status == 200")).toMatchObject({ cond: { what: "status" } });
    expect(parseConditionLine("connected")).toMatchObject({ error: expect.stringContaining("not a condition: status == 200") });
    expect(parseConditionLine("cert name == a.example.com")).toMatchObject({ error: expect.stringContaining("not a condition") });
  });
});

describe("certCovers", () => {
  test("a name, up to case, and a wildcard for the leftmost label only", () => {
    const names = ["smtp.agental.dev", "*.mail.agental.dev", "10.0.0.5"];
    expect(certCovers(names, "SMTP.agental.dev")).toBe(true);
    expect(certCovers(names, "eu.mail.agental.dev")).toBe(true);
    expect(certCovers(names, "a.eu.mail.agental.dev")).toBe(false);
    expect(certCovers(names, "mail.agental.dev")).toBe(false);
    expect(certCovers(names, "10.0.0.5")).toBe(true);
    expect(certCovers(["*.0.0.5"], "10.0.0.5")).toBe(false);
  });
});

describe("judgeNetRun", () => {
  test("a closed port fails with its error, and connected reads it", () => {
    const v = judgeNetRun("tcp", lines("connected\ntime < 200ms", "tcp"), { error: "connect ECONNREFUSED" }, now);
    expect(v).toEqual({
      result: "fail",
      line: "connected",
      why: "connect ECONNREFUSED",
      lines: [
        { pass: false, got: "no", why: "connect ECONNREFUSED" },
        { pass: null, got: "—", why: null },
      ],
    });
    // Without a connected line it still fails, and says why.
    expect(judgeNetRun("tcp", [], { error: "timeout after 10s" }, now)).toMatchObject({ result: "fail", line: null, why: "timeout after 10s" });
  });

  test("a port that answers passes, and a slow one warns on its time line", () => {
    const seen = (ms: number) => ({ host: "db.internal", seen: { durationMs: ms, cert: null } });
    expect(judgeNetRun("tcp", [], seen(3), now).result).toBe("ok");
    expect(judgeNetRun("tcp", lines("connected\ntime < 200ms   warn", "tcp"), seen(412), now)).toMatchObject({
      result: "warn",
      line: "time < 200ms",
      why: "412ms is over 200ms",
    });
    expect(judgeNetRun("tcp", lines("time < 200ms", "tcp"), seen(412), now).result).toBe("fail");
  });

  test("a certificate with 20 days left fails cert > 30d and passes cert > 14d", () => {
    const run = { host: "smtp.agental.dev", seen: { durationMs: 40, cert: cert() } };
    expect(judgeNetRun("cert", lines("cert > 30d", "cert"), run, now)).toMatchObject({
      result: "fail",
      line: "cert > 30d",
      why: "certificate expires in 20 days",
      lines: [{ pass: false, got: "20d" }],
    });
    expect(judgeNetRun("cert", lines("cert > 14d", "cert"), run, now).result).toBe("ok");
    expect(judgeNetRun("cert", [], run, now).result).toBe("ok");
  });

  test("a certificate a client would not trust fails, whatever its days", () => {
    const run = { host: "smtp.agental.dev", seen: { durationMs: 40, cert: cert({ untrusted: "certificate is self-signed" }) } };
    expect(judgeNetRun("cert", lines("cert > 14d", "cert"), run, now)).toMatchObject({
      result: "fail",
      line: null,
      why: "certificate is self-signed",
      lines: [{ pass: true, got: "20d" }],
    });
  });

  test("a certificate not for its host fails, unless a cert name line names the one it must be", () => {
    const other = { host: "10.0.0.7", seen: { durationMs: 40, cert: cert() } };
    expect(judgeNetRun("cert", [], other, now)).toMatchObject({
      result: "fail",
      why: "certificate is for smtp.agental.dev +1, not 10.0.0.7",
    });
    expect(judgeNetRun("cert", lines("cert name == smtp.agental.dev", "cert"), other, now)).toMatchObject({
      result: "ok",
      lines: [{ pass: true, got: "smtp.agental.dev" }],
    });
    expect(judgeNetRun("cert", lines("cert name == imap.agental.dev", "cert"), other, now)).toMatchObject({
      result: "fail",
      line: "cert name == imap.agental.dev",
      why: "certificate is for smtp.agental.dev +1, not imap.agental.dev",
    });
  });
});
