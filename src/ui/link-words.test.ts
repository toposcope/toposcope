import { describe, expect, test } from "bun:test";
import { filterWords, keyPositionWords, linkClock, linkPositionWords, type LinkItem } from "./link-words";

const now = Date.parse("2026-10-17T14:02:30Z");
const link = (over: Partial<LinkItem> = {}): LinkItem => ({
  id: "l_1", role: "pull", connects: "we", peer_id: "p", peer_name: "prod-eu", peer_url: "http://x", q: "service:checkout level:error", kinds: "logs,marks",
  kid: "k7f3a", position: 100, settled: 100, arrived_at: "2026-10-17T14:02:11Z", behind_rows: null, gone_from: null, gone_to: null, gone_from_at: null, gone_to_at: null,
  last_contact_at: now - 3_000, last_error: null, created_at: now - 86_400_000, ...over,
});

describe("where a link stands (#136, 6b)", () => {
  test("caught up, and under 30 seconds behind still reads caught up", () => {
    expect(linkPositionWords(link(), now)).toEqual({ text: "caught up", tone: "ok" });
    expect(linkPositionWords(link({ position: 90, arrived_at: new Date(now - 20_000).toISOString() }), now).text).toBe("caught up");
  });
  test("behind is time on a filtered link, rows and time on an every-row link", () => {
    expect(linkPositionWords(link({ position: 90, arrived_at: new Date(now - 6 * 60_000).toISOString() }), now)).toEqual({ text: "behind 6m", tone: "behind" });
    expect(
      linkPositionWords(link({ q: "", position: 90, behind_rows: 3_100, arrived_at: new Date(now - 2 * 60_000).toISOString() }), now).text,
    ).toBe("behind 3.1K rows · 2m");
  });
  test("quiet: we call them and they are not answering; they call us and have not called", () => {
    const since = Date.parse("2026-10-17T11:40:03Z");
    expect(linkPositionWords(link({ last_contact_at: since }), now)).toEqual({ text: "not answering since 11:40", tone: "quiet" });
    expect(linkPositionWords(link({ connects: "they", last_contact_at: Date.parse("2026-10-17T10:05:12Z") }), now).text).toBe("has not called since 10:05");
    expect(linkPositionWords(link({ last_error: "refused", last_contact_at: now - 1_000 }), now).tone).toBe("quiet");
    expect(linkPositionWords(link({ connects: "they", last_contact_at: Date.parse("2026-10-05T22:40:00Z") }), now).text).toBe("has not called since Oct 5");
  });
  test("clock, keys and filters", () => {
    expect(linkClock(Date.parse("2026-10-17T14:02:11Z"), now)).toBe("14:02:11");
    expect(linkClock(Date.parse("2026-10-06T09:12:00Z"), now)).toBe("Oct 6 09:12");
    expect(keyPositionWords({ kid: "k2d18", label: "k-2d18", kind: "invite", q: "env:staging", kinds: ["logs", "marks"], until: null, uses: 0, created_at: 0 })).toBe("single use · not pasted yet");
    expect(keyPositionWords({ kid: "k91c0", label: "k-91c0", kind: "invite", q: "", kinds: ["logs", "marks"], until: Date.parse("2026-10-20T00:00:00Z"), uses: 2, created_at: 0 })).toBe("until Oct 20 · used by 2");
    expect(filterWords("")).toBe("Every row — no filter");
  });
});
