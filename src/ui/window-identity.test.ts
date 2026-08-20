import { describe, expect, test } from "bun:test";
import { utcWindowStamp, windowHead, windowMeta } from "./window-identity";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("utcWindowStamp", () => {
  const t = Date.parse("2026-08-14T15:04:05.000Z");
  const now = Date.parse("2026-08-14T18:00:00.000Z");

  test("uses clock time under a day and date plus HH:MM at a day or more", () => {
    expect(utcWindowStamp(t, HOUR, now)).toBe("15:04:05");
    expect(utcWindowStamp(t, DAY, now)).toBe("2026-08-14 15:04");
  });

  test("keeps milliseconds when the window is 1s or less", () => {
    expect(utcWindowStamp(t, 1_000, now)).toBe("15:04:05.000");
    expect(utcWindowStamp(t + 12, 50, now)).toBe("15:04:05.012");
  });

  test("keeps the date when the stamp is not today", () => {
    expect(utcWindowStamp(t, HOUR, Date.parse("2026-08-15T12:00:00.000Z"))).toBe(
      "2026-08-14 15:04:05",
    );
  });
});

describe("windowHead", () => {
  test("joins from and to", () => {
    const from = Date.parse("2026-08-14T14:00:00.000Z");
    const to = Date.parse("2026-08-14T15:00:00.000Z");
    const now = Date.parse("2026-08-14T15:00:00.000Z");
    expect(windowHead(from, to, HOUR, now)).toBe("14:00:00 → 15:00:00");
  });

  test("dates both ends when the window crosses midnight", () => {
    const from = Date.parse("2026-08-16T12:50:00.000Z");
    const to = Date.parse("2026-08-17T00:50:00.000Z");
    const now = Date.parse("2026-08-16T18:00:00.000Z");
    expect(windowHead(from, to, 12 * HOUR, now)).toBe(
      "2026-08-16 12:50:00 → 2026-08-17 00:50:00",
    );
  });
});

describe("windowMeta", () => {
  test("names timezone, span, and bar width", () => {
    expect(windowMeta(HOUR, "1m")).toBe("UTC · 1h · 1m bars");
  });
});
