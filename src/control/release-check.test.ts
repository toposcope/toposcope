import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  newerReleases,
  readStoredCheck,
  releaseStep,
  releasesUrl,
  runReleaseCheck,
  splitNotes,
  startReleaseCheck,
  updateCheckOn,
  versionReply,
} from "./release-check";

// #196: Toposcope knows a newer release exists, and says nothing about itself to find out.
function memDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

const gh = (tag: string, body = "", extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: "2026-10-21T09:00:00Z",
  html_url: `https://github.com/toposcope/toposcope/releases/tag/${tag}`,
  body,
  draft: false,
  prerelease: false,
  ...extra,
});

const list = [
  gh("v0.6.1", "Toposcope knows when a release is out.\n\n**Before you upgrade:** From this version Toposcope asks GitHub once a day.\n\nEvery release ships SHA256SUMS."),
  gh("v0.7.0-rc.1", "a release candidate"),
  gh("v0.6.2", "", { draft: true }),
  gh("v0.6.3", "", { prerelease: true }),
  gh("v0.6.0", "monitors"),
  gh("v0.5.7", "panels"),
  gh("nightly", "not a version"),
];

describe("which releases are newer", () => {
  test("stable releases newer than the running one, newest first; drafts, pre-releases and odd tags left out", () => {
    const more = [gh("v0.6.10", "ten"), ...list];
    expect(newerReleases(more, "0.6.0").map((r) => r.version)).toEqual(["0.6.10", "0.6.1"]);
    expect(newerReleases(list, "0.5.6").map((r) => r.version)).toEqual(["0.6.1", "0.6.0", "0.5.7"]);
    expect(newerReleases(list, "0.6.1")).toEqual([]);
    expect(newerReleases({ message: "rate limited" }, "0.6.0")).toEqual([]);
  });

  test("a release's Before you upgrade is kept apart from its notes", () => {
    const [r] = newerReleases(list, "0.6.0");
    expect(r!.before_you_upgrade).toBe("From this version Toposcope asks GitHub once a day.");
    expect(r!.notes).toBe("Toposcope knows when a release is out.\n\nEvery release ships SHA256SUMS.");
    expect(r!.url).toBe("https://github.com/toposcope/toposcope/releases/tag/v0.6.1");
    expect(splitNotes("Only notes.")).toEqual({ notes: "Only notes.", before: null });
  });

  test("the step: before 1.0 the middle number is minor", () => {
    expect(releaseStep("0.6.0", "0.6.1")).toBe("patch");
    expect(releaseStep("0.6.1", "0.7.0")).toBe("minor");
    expect(releaseStep("0.9.4", "1.0.0")).toBe("major");
    expect(releaseStep("1.2.3", "1.3.0")).toBe("minor");
    expect(releaseStep("0.6.1", "0.6.1")).toBeNull();
    expect(releaseStep("0.6.1", "0.6.0")).toBeNull();
  });
});

describe("a check", () => {
  test("asks GitHub's list with a bare User-Agent, and keeps what it found", async () => {
    const db = memDb();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      return Response.json(list);
    }) as unknown as typeof fetch;
    const out = await runReleaseCheck({ db, fetch: fetchStub, now: () => Date.parse("2026-10-21T10:00:00Z"), running: "0.6.0" });
    expect(calls).toEqual([{ url: releasesUrl, headers: { "user-agent": "toposcope", accept: "application/vnd.github+json" } }]);
    // Nothing about the instance goes out: no version, no name, no address.
    expect(JSON.stringify(calls)).not.toContain("0.6.0");
    expect(out.error).toBeNull();
    expect(out.checked_at).toBe("2026-10-21T10:00:00.000Z");
    expect(readStoredCheck(db).releases.map((r) => r.version)).toEqual(["0.6.1"]);
  });

  test("a failed check keeps the last answer and says why, quietly", async () => {
    const db = memDb();
    const ok = (async () => Response.json(list)) as unknown as typeof fetch;
    await runReleaseCheck({ db, fetch: ok, now: () => Date.parse("2026-10-20T10:00:00Z"), running: "0.6.0" });
    const limited = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    const out = await runReleaseCheck({ db, fetch: limited, now: () => Date.parse("2026-10-21T10:00:00Z"), running: "0.6.0" });
    expect(out.error).toBe("GitHub answered 403");
    expect(out.checked_at).toBe("2026-10-20T10:00:00.000Z");
    expect(out.attempted_at).toBe("2026-10-21T10:00:00.000Z");
    expect(out.releases.map((r) => r.version)).toEqual(["0.6.1"]);
    const offline = (async () => {
      throw new Error("Unable to connect");
    }) as unknown as typeof fetch;
    expect((await runReleaseCheck({ db, fetch: offline, running: "0.6.0" })).error).toBe("Unable to connect");
  });

  test("what it found is handed on once it has an answer, and not on a failure", async () => {
    const db = memDb();
    const seen: string[][] = [];
    const onChecked = (releases: Array<{ version: string }>) => {
      seen.push(releases.map((r) => r.version));
    };
    await runReleaseCheck({ db, fetch: (async () => Response.json(list)) as unknown as typeof fetch, running: "0.6.0", onChecked });
    await runReleaseCheck({ db, fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch, running: "0.6.0", onChecked });
    expect(seen).toEqual([["0.6.1"]]);
  });
});

describe("GET /api/version's reply", () => {
  test("running, latest, the step, and every release between, newest first", async () => {
    const db = memDb();
    await runReleaseCheck({ db, fetch: (async () => Response.json(list)) as unknown as typeof fetch, running: "0.5.6", now: () => Date.parse("2026-10-21T10:00:00Z") });
    const reply = versionReply(db, {}, "0.5.6");
    expect(reply).toMatchObject({ running: "0.5.6", latest: "0.6.1", step: "minor", check: "on", checked_at: "2026-10-21T10:00:00.000Z", error: null });
    expect(reply.releases.map((r) => r.version)).toEqual(["0.6.1", "0.6.0", "0.5.7"]);
  });

  test("after an upgrade, a release the last check found that is no longer newer is not offered", async () => {
    const db = memDb();
    await runReleaseCheck({ db, fetch: (async () => Response.json(list)) as unknown as typeof fetch, running: "0.6.0" });
    expect(versionReply(db, {}, "0.6.1")).toMatchObject({ running: "0.6.1", latest: "0.6.1", step: null, releases: [] });
  });

  test("off: no call is made, and the reply says the check is off", async () => {
    expect(updateCheckOn({})).toBe(true);
    expect(updateCheckOn({ TOPOSCOPE_UPDATE_CHECK: "off" })).toBe(false);
    expect(updateCheckOn({ TOPOSCOPE_UPDATE_CHECK: " OFF " })).toBe(false);
    expect(updateCheckOn({ TOPOSCOPE_UPDATE_CHECK: "false" })).toBe(false);
    const db = memDb();
    const never = (async () => {
      throw new Error("no call may be made while the check is off");
    }) as unknown as typeof fetch;
    expect(startReleaseCheck({ db, fetch: never }, { TOPOSCOPE_UPDATE_CHECK: "off" })).toBe(false);
    expect(startReleaseCheck({ db, fetch: never }, {})).toBe(true);
    await runReleaseCheck({ db, fetch: (async () => Response.json(list)) as unknown as typeof fetch, running: "0.6.0" });
    expect(versionReply(db, { TOPOSCOPE_UPDATE_CHECK: "off" }, "0.6.0")).toEqual({
      running: "0.6.0",
      latest: "0.6.0",
      step: null,
      check: "off",
      checked_at: null,
      error: null,
      releases: [],
    });
  });
});
