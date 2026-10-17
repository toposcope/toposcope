import { describe, expect, test } from "bun:test";
import { windowHead } from "./window-identity";

// The summary head ("12 matching <from> → <to>") read the first bar's start, which the
// histogram floors to the bar width, plus the span. On a window off the bar grid it shifted
// back by up to one bar: the clock read 10-15 22:33:30 → 10-16 19:42:09 and the head
// 2026-10-15 22:30:00 → 2026-10-16 19:38:39, ending before the window's last row at 19:42:08.
// The head must read the window the search sent, as /api/search answers it.

const now = Date.parse("2026-10-17T03:53:00.000Z");

async function head(reply: { from: string; to: string }): Promise<string> {
  const { searchWindowMs } = await import("./window-identity");
  // Before a reply the head falls back to the clock; here the clock asked for the same window.
  const clock = { fromMs: Date.parse(reply.from), toMs: Date.parse(reply.to) };
  const { fromMs, toMs } = searchWindowMs(reply, clock);
  return windowHead(fromMs, toMs, toMs - fromMs, now);
}

describe("the summary head on a window off the bar grid", () => {
  // Custom window, 15m bars: the first bar starts at 22:30:00.
  const custom = { from: "2026-10-15T22:33:30.000Z", to: "2026-10-16T19:42:09.000Z" };

  test("reads the window the search sent, not the first bar's start", async () => {
    const text = await head(custom);
    expect(text).not.toBe("2026-10-15 22:30:00 → 2026-10-16 19:38:39");
    expect(text).toBe("2026-10-15 22:33:30 → 2026-10-16 19:42:09");
  });

  test("does not end before the window's last row", async () => {
    const { searchWindowMs } = await import("./window-identity");
    const { toMs } = searchWindowMs(custom, { fromMs: Number.NaN, toMs: Number.NaN });
    expect(toMs).toBeGreaterThanOrEqual(Date.parse("2026-10-16T19:42:08.000Z"));
  });

  test("keeps a wheel zoom's own ends", async () => {
    // Zoom about the cursor: 15m bars, the first bar starts at 15:30:00.
    const zoom = { from: "2026-10-15T15:37:30.000Z", to: "2026-10-16T03:37:30.000Z" };
    const text = await head(zoom);
    expect(text).not.toBe("2026-10-15 15:30:00 → 2026-10-16 03:30:00");
    expect(text).toBe("2026-10-15 15:37:30 → 2026-10-16 03:37:30");
  });

  test("keeps a Follow window's own ends", async () => {
    // Follow ±5m around 15:51:28.364: 10s bars, the first bar starts at 15:46:20.
    const follow = { from: "2026-10-16T15:46:28.364Z", to: "2026-10-16T15:56:28.364Z" };
    const text = await head(follow);
    expect(text).not.toBe("2026-10-16 15:46:20 → 2026-10-16 15:56:20");
    expect(text).toBe("2026-10-16 15:46:28 → 2026-10-16 15:56:28");
  });
});
