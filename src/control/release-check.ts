import type { Database } from "bun:sqlite";
import { compareVersions as compare, parseVersion, releaseStep, type Release, type VersionReply } from "../shared/releases";
import { version as runningVersion } from "../shared/version";
import { getDb } from "./index";

export { parseVersion, releaseStep, type Release, type Step, type VersionReply } from "../shared/releases";

/**
 * Toposcope knows when a newer release is out (#196). Once a day, and a few minutes after boot,
 * it reads GitHub's public releases list and keeps every stable release newer than the one
 * running: version, date, link, notes, and the release's own Before you upgrade. It sends nothing
 * about the instance: no version, no name, no address (GitHub still sees the box's IP). A check
 * that fails keeps the last answer and notes the failure quietly. On by default;
 * `TOPOSCOPE_UPDATE_CHECK=off` makes no call at all. `/api/health` is unchanged: it needs no
 * sign-in, so it must not say how far behind an instance is.
 */

type Env = Record<string, string | undefined>;

export const releasesUrl = "https://api.github.com/repos/toposcope/toposcope/releases?per_page=30";

/** What the last check found, kept in SQLite `settings` under `update_check`. */
export type StoredCheck = {
  /** The last check that got an answer. */
  checked_at: string | null;
  /** Why the last attempt failed, or null when it got an answer. */
  error: string | null;
  attempted_at: string | null;
  /** Every stable release newer than the version that ran the check, newest first. */
  releases: Release[];
};

const offWords = new Set(["off", "false", "0", "no"]);

export function updateCheckOn(env: Env = process.env): boolean {
  return !offWords.has((env.TOPOSCOPE_UPDATE_CHECK ?? "").trim().toLowerCase());
}

type Semver = NonNullable<ReturnType<typeof parseVersion>>;

const lead = /^\*\*Before you upgrade:\*\*\s*/;

/** A release body's Before you upgrade paragraph, apart from its other notes. */
export function splitNotes(body: string): { notes: string; before: string | null } {
  const paragraphs = body.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const at = paragraphs.findIndex((p) => lead.test(p.trim()));
  if (at === -1) {
    return { notes: body.trim(), before: null };
  }
  const before = paragraphs[at]!.trim().replace(lead, "").trim();
  const notes = paragraphs.filter((_, i) => i !== at).join("\n\n").trim();
  return { notes, before: before || null };
}

/** GitHub's releases list → the stable releases newer than `running`, newest first. */
export function newerReleases(json: unknown, running: string): Release[] {
  const base = parseVersion(running);
  if (!base || !Array.isArray(json)) {
    return [];
  }
  const out: Array<{ v: Semver; release: Release }> = [];
  for (const item of json) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const r = item as Record<string, unknown>;
    if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") {
      continue;
    }
    const v = parseVersion(r.tag_name);
    if (!v || compare(v, base) <= 0) {
      continue;
    }
    const { notes, before } = splitNotes(typeof r.body === "string" ? r.body : "");
    out.push({
      v,
      release: {
        version: v.join("."),
        published_at: typeof r.published_at === "string" ? r.published_at : null,
        url: typeof r.html_url === "string" ? r.html_url : null,
        notes,
        before_you_upgrade: before,
      },
    });
  }
  return out.sort((a, b) => compare(b.v, a.v)).map((x) => x.release);
}

const settingsKey = "update_check";
const emptyCheck: StoredCheck = { checked_at: null, error: null, attempted_at: null, releases: [] };

export function readStoredCheck(db: Database = getDb()): StoredCheck {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(settingsKey) as { value: string } | null;
  if (!row) {
    return emptyCheck;
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredCheck>;
    return {
      checked_at: parsed.checked_at ?? null,
      error: parsed.error ?? null,
      attempted_at: parsed.attempted_at ?? null,
      releases: Array.isArray(parsed.releases) ? parsed.releases : [],
    };
  } catch {
    return emptyCheck;
  }
}

function writeStoredCheck(check: StoredCheck, db: Database): void {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    settingsKey,
    JSON.stringify(check),
  );
}

export type CheckDeps = {
  db?: Database;
  fetch?: typeof fetch;
  now?: () => number;
  running?: string;
  /** Called with what a check that got an answer found (#197 writes its row from here). */
  onChecked?: (releases: Release[], running: string) => unknown;
};

const checkTimeoutMs = 10_000;

/** One check: read the list, keep what is newer; on failure keep the last answer and say why. */
export async function runReleaseCheck(deps: CheckDeps = {}): Promise<StoredCheck> {
  const db = deps.db ?? getDb();
  const now = new Date((deps.now ?? Date.now)()).toISOString();
  const running = deps.running ?? runningVersion;
  const last = readStoredCheck(db);
  let releases: Release[];
  try {
    // GitHub refuses a request without a User-Agent; this one names the product and nothing else.
    const res = await (deps.fetch ?? fetch)(releasesUrl, {
      headers: { "user-agent": "toposcope", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(checkTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`GitHub answered ${res.status}`);
    }
    releases = newerReleases(await res.json(), running);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failed: StoredCheck = { ...last, error: reason.slice(0, 200), attempted_at: now };
    writeStoredCheck(failed, db);
    return failed;
  }
  const checked: StoredCheck = { checked_at: now, error: null, attempted_at: now, releases };
  writeStoredCheck(checked, db);
  await deps.onChecked?.(releases, running);
  return checked;
}

/** What `GET /api/version` says: what runs, what is out, and every release in between. */
export function versionReply(db: Database = getDb(), env: Env = process.env, running: string = runningVersion): VersionReply {
  if (!updateCheckOn(env)) {
    return { running, latest: running, step: null, check: "off", checked_at: null, error: null, releases: [] };
  }
  const stored = readStoredCheck(db);
  const base = parseVersion(running);
  // A release the last check found may be the one running now, after an upgrade.
  const releases = base ? stored.releases.filter((r) => { const v = parseVersion(r.version); return v !== null && compare(v, base) > 0; }) : [];
  const latest = releases[0]?.version ?? running;
  return {
    running,
    latest,
    step: releaseStep(running, latest),
    check: "on",
    checked_at: stored.checked_at,
    error: stored.error,
    releases,
  };
}

/** A check by hand is not repeated within this long of the last attempt: clicks do not spend GitHub's limit. */
export const manualCheckGapMs = 30_000;

/**
 * Check now (#219): one check, as the daily one, then what `GET /api/version` answers. A check
 * attempted under 30s ago answers the stored result instead; off, nobody is called.
 */
export async function checkReleasesNow(deps: CheckDeps = {}, env: Env = process.env): Promise<VersionReply> {
  const db = deps.db ?? getDb();
  if (updateCheckOn(env)) {
    const last = readStoredCheck(db).attempted_at;
    const now = (deps.now ?? Date.now)();
    if (!last || now - Date.parse(last) >= manualCheckGapMs) {
      await runReleaseCheck({ ...deps, db });
    }
  }
  return versionReply(db, env, deps.running);
}

const firstDelayMs = 5 * 60_000;
const dayMs = 24 * 60 * 60_000;
const jitterMs = 60 * 60_000;
const freshMs = 12 * 60 * 60_000;

/**
 * The daily check: a few minutes after boot, unless the last answer is under 12 hours old, then
 * every 24 hours give or take one, so a fleet does not call at the same minute. Off, it never runs.
 */
/** Whether the check was started: off, it never is. */
export function startReleaseCheck(deps: CheckDeps = {}, env: Env = process.env): boolean {
  if (!updateCheckOn(env)) {
    return false;
  }
  const now = deps.now ?? Date.now;
  const schedule = (delay: number) => {
    const timer = setTimeout(() => {
      void runReleaseCheck(deps)
        .catch((err) => console.error("release check failed", err))
        .finally(() => schedule(dayMs - jitterMs + Math.random() * 2 * jitterMs));
    }, delay);
    // The app exits on its own signal; this timer must never keep it, or a test harness, alive.
    timer.unref?.();
  };
  const last = readStoredCheck(deps.db ?? getDb()).checked_at;
  const age = last ? now() - Date.parse(last) : Infinity;
  schedule(age < freshMs ? Math.max(firstDelayMs, freshMs - age) : firstDelayMs);
  return true;
}
