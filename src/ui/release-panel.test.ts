import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Release, Upgrader, UpgradeStatus, VersionReply } from "../shared/releases";
import { ReleasePanel } from "./components/version-footer";
import { agoLabel, backupLabel, backupSize, beforeItems, noteParagraphs, tookLabel, upgradeCommand, upgradeView, versionChip } from "./release-panel";

// #201, frames 19b–19g: the footer's version and the popover it opens.
const r = (version: string, before: string | null = null, notes = `Notes for ${version}.`): Release => ({
  version,
  published_at: version === "0.5.7" ? "2026-10-18T12:00:00Z" : "2026-10-20T12:00:00Z",
  url: `https://github.com/toposcope/toposcope/releases/tag/v${version}`,
  notes,
  before_you_upgrade: before,
});
const before061 = "From this version Toposcope asks GitHub once a day whether a newer release is out. It sends nothing about this instance. Set `TOPOSCOPE_UPDATE_CHECK=off` in `.env` to stop it.";
const reply = (extra: Partial<VersionReply>): VersionReply => ({
  running: "0.6.0",
  latest: "0.6.0",
  step: null,
  check: "on",
  checked_at: "2026-10-21T07:00:00Z",
  error: null,
  releases: [],
  ...extra,
});
const now = Date.parse("2026-10-21T10:00:00Z");
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const store = { clickhouse_bytes: 1.16 * GiB, sqlite_bytes: 41 * MiB };
const draw = (v: VersionReply) => renderToStaticMarkup(createElement(ReleasePanel, { reply: { ...v, store }, now }));
const text = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("the footer item", () => {
  test("the bare version when nothing newer is known; running → latest when it is; a dot to read first", () => {
    expect(versionChip(reply({}))).toMatchObject({ newer: null, readFirst: false, label: "Toposcope 0.6.0, up to date" });
    expect(versionChip(reply({ latest: "0.6.1", step: "patch", releases: [r("0.6.1")] }))).toMatchObject({ newer: "0.6.1", readFirst: false });
    expect(versionChip(reply({ latest: "0.6.1", step: "patch", releases: [r("0.6.1", before061)] }))).toMatchObject({
      newer: "0.6.1",
      readFirst: true,
      label: "Toposcope 0.6.0, 0.6.1 is out, read before upgrading",
    });
  });

  test("a failed or switched-off check never claims up to date (19g)", () => {
    expect(versionChip(reply({ error: "GitHub answered 403" })).label).toBe("Toposcope 0.6.0");
    expect(versionChip(reply({ check: "off", checked_at: null })).label).toBe("Toposcope 0.6.0");
  });
});

describe("the popover's pieces", () => {
  test("notes are paragraphs of text, inline code and https links only", () => {
    expect(noteParagraphs("A `GET /api/version` and [the docs](https://example.com/x).\n\nSecond **para**.")).toEqual([
      [
        { kind: "text", text: "A " },
        { kind: "code", text: "GET /api/version" },
        { kind: "text", text: " and " },
        { kind: "link", text: "the docs", href: "https://example.com/x" },
        { kind: "text", text: "." },
      ],
      [{ kind: "text", text: "Second para." }],
    ]);
    expect(noteParagraphs("[x](javascript:alert(1))")).toEqual([[{ kind: "text", text: "[x](javascript:alert(1))" }]]);
  });

  test("Before you upgrade, all together: 0.6.0 and earlier link to the operations guide; nothing to read, no box (19d, 19e)", () => {
    expect(beforeItems([r("0.6.1", before061), r("0.6.0"), r("0.5.7")])).toEqual([
      { version: "0.6.1", text: before061, guide: false },
      { version: "0.6.0", text: null, guide: true },
      { version: "0.5.7", text: null, guide: true },
    ]);
    expect(beforeItems([r("0.6.2"), r("0.6.1")])).toEqual([]);
    expect(beforeItems([r("0.7.0", "[0.7.0's]"), r("0.6.2")])).toEqual([{ version: "0.7.0", text: "[0.7.0's]", guide: false }]);
  });

  test("the command is exact, with the version read, never latest (19f)", () => {
    expect(upgradeCommand("0.6.1")).toBe("./upgrade.sh 0.6.1");
  });

  test("the backup's size comes from the stores' own sizes (19c)", () => {
    expect(backupSize(store)).toBe("about 1.2 GB (ClickHouse 1.16 GB, SQLite 41 MB)");
    expect(backupSize(null)).toBeNull();
  });

  test("when it last checked", () => {
    expect(agoLabel("2026-10-21T07:00:00Z", now)).toBe("3 hours ago");
    expect(agoLabel("2026-10-21T09:59:30Z", now)).toBe("just now");
    expect(agoLabel("2026-10-18T07:00:00Z", now)).toBe("on 18 Oct");
  });
});

describe("the popover", () => {
  test("up to date (19b)", () => {
    const t = text(draw(reply({})));
    expect(t).toContain("Toposcope 0.6.0");
    expect(t).toContain("Up to date · checked 3 hours ago");
    expect(t).toContain("TOPOSCOPE_UPDATE_CHECK=off");
  });

  test("a patch out (19c): Before you upgrade first, then what's new, then the one command", () => {
    const t = text(draw(reply({ latest: "0.6.1", step: "patch", releases: [r("0.6.1", before061, "Toposcope knows when a release is out.")] })));
    expect(t).toContain("Toposcope 0.6.1 is out");
    expect(t).toContain("you run 0.6.0 · patch · 20 Oct 2026");
    const before = t.indexOf("Before you upgrade");
    const news = t.indexOf("What's new in 0.6.1");
    const cmd = t.indexOf("./upgrade.sh 0.6.1");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(news);
    expect(news).toBeLessThan(cmd);
    expect(t).toContain("Backs up both stores first: about 1.2 GB (ClickHouse 1.16 GB, SQLite 41 MB). Ingest stops while it runs.");
    expect(t).toContain("Checked 3 hours ago");
  });

  test("a patch with nothing to read first has no Before you upgrade box at all (19d)", () => {
    expect(text(draw(reply({ latest: "0.6.1", step: "patch", releases: [r("0.6.1")] })))).not.toContain("Before you upgrade");
  });

  test("three releases behind (19e): counted, read together, one command to the latest", () => {
    const t = text(draw(reply({ running: "0.5.6", latest: "0.6.1", step: "minor", releases: [r("0.6.1", before061), r("0.6.0"), r("0.5.7")] })));
    expect(t).toContain("3 releases since yours");
    expect(t).toContain("you run 0.5.6 · latest 0.6.1 · minor");
    expect(t.match(/Upgrade notes for this release are in the operations guide/g)).toHaveLength(2);
    expect(t).toContain("Upgrade to 0.6.1");
    expect(t).toContain("./upgrade.sh 0.6.1");
    expect(t.match(/Show all/g)).toHaveLength(3);
  });

  test("could not check, and nothing newer known (19g): says so, never up to date", () => {
    const t = text(draw(reply({ checked_at: "2026-10-18T07:00:00Z", error: "api.github.com: connection timed out" })));
    expect(t).toContain("Could not check for releases since 18 Oct");
    expect(t).toContain("api.github.com: connection timed out");
    expect(t).toContain("The last answer, on 18 Oct, knew of nothing newer.");
    expect(t).not.toContain("Up to date");
  });

  test("could not check, with a newer release known: the arrow stays and the line goes under the header (19g)", () => {
    const t = text(draw(reply({ latest: "0.6.1", step: "patch", error: "GitHub answered 403", checked_at: "2026-10-18T07:00:00Z", releases: [r("0.6.1")] })));
    expect(t).toContain("Toposcope 0.6.1 is out");
    expect(t).toContain("Could not check for releases since 18 Oct");
    expect(t).toContain("Last answer on 18 Oct");
    expect(t).not.toContain("Checked");
  });

  test("the check off (19g): said plainly", () => {
    const t = text(draw(reply({ check: "off", checked_at: null })));
    expect(t).toContain("The release check is off (TOPOSCOPE_UPDATE_CHECK=off)");
    expect(t).toContain("calls nobody to find out");
    expect(t).not.toContain("Up to date");
  });
});

describe("Check now (#219)", () => {
  const drawWith = (v: VersionReply, checking = false) =>
    renderToStaticMarkup(createElement(ReleasePanel, { reply: { ...v, store }, now, checking, onCheck: () => undefined }));
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].filter((m) => text(m[1]!) === "Check now").map((m) => m[0]);

  test("on the status line when up to date (22a)", () => {
    const html = drawWith(reply({}));
    expect(text(html)).toContain("Up to date · checked 3 hours ago");
    expect(buttons(html)).toHaveLength(1);
    expect(buttons(html)[0]).not.toContain(` disabled=""`);
  });

  test("while it runs the line says so and the button is off (22b)", () => {
    const html = drawWith(reply({}), true);
    expect(text(html)).toContain("Checking GitHub for releases…");
    expect(text(html)).not.toContain("Up to date");
    expect(buttons(html)[0]).toContain(` disabled=""`);
  });

  test("with a release out it sits at the foot, beside Checked (22c)", () => {
    const html = drawWith(reply({ latest: "0.6.1", step: "patch", releases: [r("0.6.1")] }));
    expect(text(html)).toContain("Checked 3 hours ago");
    expect(buttons(html)).toHaveLength(1);
  });

  test("a failed check offers it once, to try again (22d)", () => {
    const html = drawWith(reply({ checked_at: "2026-10-18T07:00:00Z", error: "GitHub answered 403" }));
    expect(text(html)).toContain("Could not check for releases since 18 Oct");
    expect(buttons(html)).toHaveLength(1);
  });

  test("under an upgrade's done too (22i)", () => {
    const done = reply({
      running: "0.6.1",
      upgrader: { enabled: true, requested: null, log: [], status: { state: "done", to: "0.6.1", from: "0.6.0", started_at: "2026-10-21T09:59:37Z", finished_at: "2026-10-21T10:00:18Z", backup: null, message: null } },
    });
    const html = drawWith(done);
    expect(text(html)).toContain("Upgraded from 0.6.0");
    expect(buttons(html)).toHaveLength(1);
  });

  test("no button without a handler, as the footer gives none while the check is off", () => {
    expect(buttons(draw(reply({})))).toHaveLength(0);
    expect(buttons(draw(reply({ check: "off", checked_at: null })))).toHaveLength(0);
  });
});

describe("upgrade from here (#220)", () => {
  const out = { latest: "0.6.1", step: "patch" as const, releases: [r("0.6.1")] };
  const upgrader = (extra: Partial<Upgrader> = {}): Upgrader => ({ enabled: true, requested: null, status: null, log: [], ...extra });
  const st = (extra: Partial<UpgradeStatus>): UpgradeStatus => ({
    state: "running",
    to: "0.6.1",
    from: "0.6.0",
    started_at: "2026-10-21T09:59:37Z",
    finished_at: null,
    backup: null,
    message: null,
    ...extra,
  });
  const drawUp = (v: VersionReply) =>
    renderToStaticMarkup(createElement(ReleasePanel, { reply: { ...v, store }, now, onUpgrade: async () => null }));

  test("off: today's command, and how to turn it on (22e)", () => {
    const t = text(drawUp(reply({ ...out, upgrader: upgrader({ enabled: false }) })));
    expect(t).toContain("./upgrade.sh 0.6.1");
    expect(t).toContain("To upgrade from here instead, run ./upgrade.sh enable-ui once on the host (Linux with systemd).");
    expect(t).not.toContain("Upgrade to 0.6.1");
  });

  test("on: a button, the command one click away (22f)", () => {
    const t = text(drawUp(reply({ ...out, upgrader: upgrader() })));
    expect(t).toContain("Upgrade to 0.6.1");
    expect(t).toContain("The host runs it; this page reconnects after.");
    expect(t).toContain("Or on the host");
    expect(t).toContain("./upgrade.sh 0.6.1");
    expect(t).not.toContain("enable-ui");
  });

  test("asked or running: the host's log, and the page waits (22h)", () => {
    const asked = reply({ ...out, upgrader: upgrader({ requested: { version: "0.6.1", requested_at: "2026-10-21T09:59:50Z" } }) });
    expect(upgradeView(asked, now)).toBe("running");
    expect(text(drawUp(asked))).toContain("Asked; waiting for the host to start it…");
    const running = reply({ ...out, upgrader: upgrader({ status: st({}), log: ["Toposcope 0.6.0 → 0.6.1", "pulled", "stopped", "Backing up about 1200 MB"] }) });
    const t = text(drawUp(running));
    expect(t).toContain("Upgrading to 0.6.1");
    expect(t).toContain("· 23s");
    expect(t).toContain("Backing up about 1200 MB");
    expect(t).toContain("Toposcope stops while this runs. This page reconnects when it is back.");
    expect(t).not.toContain("Upgrade to 0.6.1");
  });

  test("done, once the new version answers: from, how long, the backup and the way back (22i)", () => {
    const done = reply({
      running: "0.6.1",
      upgrader: upgrader({ status: st({ state: "done", finished_at: "2026-10-21T10:00:18Z", backup: "/opt/toposcope/backups/20261021T095940Z-0.6.0" }) }),
    });
    expect(upgradeView(done, now)).toBe("done");
    const t = text(drawUp(done));
    expect(t).toContain("Upgraded from 0.6.0 · took 41s · backup in backups/20261021T095940Z-0.6.0");
    expect(t).toContain("./upgrade.sh rollback --yes");
    // Said for the hour it happened, then the popover is today's again.
    expect(upgradeView(done, now + 50 * 60_000)).toBe("done");
    expect(upgradeView(done, now + 61 * 60_000)).toBeNull();
  });

  test("failed and back on the old version: why, the log's tail, Try again (22j)", () => {
    const failed = reply({
      ...out,
      upgrader: upgrader({ status: st({ state: "failed", finished_at: "2026-10-21T10:02:00Z", message: "Toposcope 0.6.1 did not come up." }), log: ["a", "b", "Back on 0.6.0."] }),
    });
    expect(upgradeView(failed, now)).toBe("failed");
    const t = text(drawUp(failed));
    expect(t).toContain("Upgrade to 0.6.1 failed · back on 0.6.0");
    expect(t).toContain("Toposcope 0.6.1 did not come up.");
    expect(t).toContain("Back on 0.6.0.");
    expect(t).toContain("Try again");
  });

  test("labels", () => {
    expect(backupLabel("/opt/toposcope/backups/20261024T140210Z-0.6.2/")).toBe("backups/20261024T140210Z-0.6.2");
    expect(backupLabel(null)).toBeNull();
    expect(tookLabel("2026-10-24T14:02:05Z", "2026-10-24T14:04:10Z")).toBe("2m 05s");
  });
});
