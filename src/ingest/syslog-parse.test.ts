import { describe, expect, test } from "bun:test";
import { parseSyslog3164, formatSyslog3164 } from "./syslog-parse";

describe("parseSyslog3164", () => {
  test("parses pri, stamp, host, tag, message", () => {
    const event = parseSyslog3164(
      "<27>Aug 14 01:02:03 api-1 nginx: timeout on upstream",
      new Date(Date.UTC(2026, 7, 14)),
    );
    expect(event).not.toBeNull();
    expect(event?.host).toBe("api-1");
    expect(event?.service).toBe("nginx");
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("timeout on upstream");
    expect(event?.ts).toBe("2026-08-14T01:02:03.000Z");
  });

  test("strips pid from tag and maps debug", () => {
    const event = parseSyslog3164(
      "<15>Jan  1 00:00:00 box app[12]: hello",
      new Date(Date.UTC(2026, 0, 1)),
    );
    expect(event?.service).toBe("app");
    expect(event?.level).toBe("debug");
  });

  test("drops junk", () => {
    expect(parseSyslog3164("not syslog")).toBeNull();
    expect(parseSyslog3164("<14>nope")).toBeNull();
  });

  test("format round-trips through the parser", () => {
    const raw = formatSyslog3164({
      ts: "2026-08-14T01:02:03.500Z",
      service: "api",
      host: "api-1",
      level: "error",
      message: "timeout on upstream",
    });
    const event = parseSyslog3164(raw, new Date(Date.UTC(2026, 7, 14)));
    expect(raw.startsWith("<131>")).toBe(true);
    expect(event?.service).toBe("api");
    expect(event?.host).toBe("api-1");
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("timeout on upstream");
    expect(event?.ts).toBe("2026-08-14T01:02:03.000Z");
  });
});
