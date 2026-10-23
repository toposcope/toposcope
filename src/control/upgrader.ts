import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSqlitePath } from "../shared/sqlite-path";
import type { Upgrader, UpgradeStatus } from "../shared/releases";

/**
 * Upgrade from here (#220). The app never runs an upgrade: that would need the Docker socket,
 * which is root on the host for anyone with the password. It writes `upgrade/request.json` into
 * its own data volume; on a host where `./upgrade.sh enable-ui` was run, a systemd path unit sees
 * it and runs `upgrade.sh ui-run`, which writes `status.json` and `last.log` back beside it.
 * `enabled` there is how the app knows the host is listening.
 */

type Env = Record<string, string | undefined>;

export type UpgraderDeps = { dir?: string; now?: () => number };

export function upgradeDir(env: Env = process.env): string {
  return env.TOPOSCOPE_UPGRADE_DIR ?? join(dirname(defaultSqlitePath(env)), "upgrade");
}

/** A request the host has not taken in this long is not waiting any more: it is dropped. */
export const requestStaleMs = 2 * 60_000;
/** A run that has said nothing for this long is over, whatever its status says. */
export const runningStaleMs = 2 * 60 * 60_000;
const logLines = 8;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function readStatus(path: string, now: number): UpgradeStatus | null {
  const raw = readJson(path);
  const state = raw?.state;
  if (!raw || (state !== "running" && state !== "done" && state !== "failed")) {
    return null;
  }
  const status: UpgradeStatus = {
    state,
    to: str(raw.to),
    from: str(raw.from),
    started_at: str(raw.started_at),
    finished_at: str(raw.finished_at),
    backup: str(raw.backup),
    message: str(raw.message),
  };
  // A host that died mid-run never writes its end: after two quiet hours the run is over.
  if (status.state === "running") {
    const last = Math.max(Date.parse(status.started_at ?? "") || 0, modified(path));
    if (now - last > runningStaleMs) {
      return { ...status, state: "failed", message: status.message ?? "The host stopped saying how the upgrade went." };
    }
  }
  return status;
}

function modified(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function tail(path: string): string[] {
  try {
    const text = readFileSync(path, "utf8");
    return text
      .slice(-16_384)
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "")
      .slice(-logLines);
  } catch {
    return [];
  }
}

export function readUpgrader(deps: UpgraderDeps = {}): Upgrader {
  const dir = deps.dir ?? upgradeDir();
  const now = (deps.now ?? Date.now)();
  const requestPath = join(dir, "request.json");
  let requested: Upgrader["requested"] = null;
  const raw = readJson(requestPath);
  const version = str(raw?.version);
  const at = str(raw?.requested_at);
  if (version && at) {
    if (now - Date.parse(at) > requestStaleMs) {
      // Nobody took it: it must not start an upgrade later, unasked.
      rmSync(requestPath, { force: true });
    } else {
      requested = { version, requested_at: at };
    }
  }
  return {
    enabled: existsSync(join(dir, "enabled")),
    requested,
    status: readStatus(join(dir, "status.json"), now),
    log: tail(join(dir, "last.log")),
  };
}

export type UpgradeAnswer = { status: 202 | 400 | 404 | 409; body: { error?: string; upgrader?: Upgrader } };

/** `POST /api/version/upgrade { version }`: only when the host listens, only a release known as newer, one at a time. */
export function requestUpgrade(version: unknown, known: string[], deps: UpgraderDeps = {}): UpgradeAnswer {
  const dir = deps.dir ?? upgradeDir();
  const now = (deps.now ?? Date.now)();
  const current = readUpgrader({ ...deps, dir });
  if (!current.enabled) {
    return { status: 404, body: { error: "Upgrading from here is off. Run ./upgrade.sh enable-ui on the host to turn it on." } };
  }
  if (typeof version !== "string" || !known.includes(version)) {
    return { status: 400, body: { error: "version must be a release newer than this one that the release check knows" } };
  }
  if (current.requested || current.status?.state === "running") {
    return { status: 409, body: { error: "An upgrade is already asked for or running", upgrader: current } };
  }
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, ".request.json.new");
  writeFileSync(tmp, JSON.stringify({ version, requested_at: new Date(now).toISOString() }) + "\n");
  // The host's path unit fires on the file appearing: it appears whole.
  renameSync(tmp, join(dir, "request.json"));
  return { status: 202, body: { upgrader: readUpgrader({ ...deps, dir }) } };
}
