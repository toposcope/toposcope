import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { actorName, currentActorRef, type ActorName } from "./actors";
import { getDb } from "./index";
import { githubApp } from "../shared/github-app";

/**
 * Connect GitHub (#416, frames 42a–42h). One Toposcope GitHub App, read-only on repository
 * metadata, with no webhook and no callback: an Owner signs this instance in with GitHub's device
 * flow, and the token GitHub hands back is kept here and only lists the repositories the App was
 * installed on, for Set. It is never sent to a browser. Nothing passes through a server of ours.
 *
 * The device flow is driven by the page: while a code is waiting, each `GET /api/github` asks
 * GitHub once its interval has passed, so there is no timer to leak.
 */

export type GithubState = {
  configured: boolean;
  state: "off" | "connecting" | "on" | "ended";
  install_url: string;
  login?: string;
  connected_by?: ActorName | null;
  connected_at?: number;
  ended_at?: number;
  code?: { user_code: string; verification_uri: string; expires_at: number };
  accounts?: string[];
  repositories?: number;
  error?: string;
};

export type GithubRepo = { url: string; name: string; owner: string; private: boolean };

type Row = { token: string | null; login: string | null; connected_by: string | null; connected_at: number | null; ended_at: number | null };

type Pending = { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; interval: number; nextPoll: number; by: string | null };

let pending: Pending | null = null;
let lastError: string | undefined;
let cache: { at: number; token: string; accounts: string[]; repos: GithubRepo[] } | null = null;

/** How long a repository list is reused before GitHub is asked again. */
const cacheMs = 30_000;
/** Most repositories read per installation: ten pages of a hundred. */
const maxPages = 10;

export function migrateGithub(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS github_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT,
      login TEXT,
      connected_by TEXT,
      connected_at INTEGER,
      ended_at INTEGER
    );
  `);
}

function row(db: Database): Row | null {
  return (db.query("SELECT token, login, connected_by, connected_at, ended_at FROM github_connection WHERE id = 1").get() as Row | null) ?? null;
}

/** For tests: forget the code waiting and the cached list. */
export function resetGithubForTests(): void {
  pending = null;
  lastError = undefined;
  cache = null;
}

async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) {
    throw new Error(`GitHub answered ${res.status}`);
  }
  return json;
}

class Ended extends Error {}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${githubApp.apiUrl}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (res.status === 401) {
    throw new Ended("GitHub no longer accepts this connection");
  }
  if (!res.ok) {
    throw new Error(`GitHub answered ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

/** A token GitHub refuses ends the connection (42h); the repositories set here stay. */
function end(db: Database): void {
  db.run("UPDATE github_connection SET token = NULL, ended_at = ? WHERE id = 1", [Date.now()]);
  cache = null;
}

/** Every repository the App was installed on, across the accounts that installed it. */
async function listAll(db: Database, token: string, fresh = false): Promise<{ accounts: string[]; repos: GithubRepo[] }> {
  if (!fresh && cache && cache.token === token && Date.now() - cache.at < cacheMs) {
    return cache;
  }
  try {
    const inst = await api<{ installations: { id: number; account: { login: string } | null }[] }>(token, "/user/installations?per_page=100");
    const accounts: string[] = [];
    const repos: GithubRepo[] = [];
    for (const i of inst.installations) {
      if (i.account?.login) {
        accounts.push(i.account.login);
      }
      for (let page = 1; page <= maxPages; page++) {
        const r = await api<{ total_count: number; repositories: { full_name: string; html_url: string; private: boolean; owner: { login: string } }[] }>(
          token,
          `/user/installations/${i.id}/repositories?per_page=100&page=${page}`,
        );
        for (const repo of r.repositories) {
          repos.push({ url: repo.html_url, name: repo.full_name, owner: repo.owner.login, private: repo.private });
        }
        if (r.repositories.length < 100 || repos.length >= r.total_count) {
          break;
        }
      }
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: Date.now(), token, accounts: [...new Set(accounts)].sort(), repos };
    return cache;
  } catch (err) {
    if (err instanceof Ended) {
      end(db);
    }
    throw err;
  }
}

/** Ask GitHub once whether the code was entered, when its interval has passed. */
async function poll(db: Database): Promise<void> {
  const p = pending;
  if (!p) {
    return;
  }
  if (Date.now() > p.expiresAt) {
    pending = null;
    lastError = "The code ran out before GitHub was approved. Connect again.";
    return;
  }
  if (Date.now() < p.nextPoll) {
    return;
  }
  p.nextPoll = Date.now() + p.interval * 1000;
  const json = await form(`${githubApp.webUrl}/login/oauth/access_token`, {
    client_id: githubApp.clientId,
    device_code: p.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const error = typeof json.error === "string" ? json.error : null;
  if (error === "authorization_pending") {
    return;
  }
  if (error === "slow_down") {
    p.interval = typeof json.interval === "number" ? json.interval : p.interval + 5;
    p.nextPoll = Date.now() + p.interval * 1000;
    return;
  }
  pending = null;
  if (error || typeof json.access_token !== "string") {
    lastError = error === "access_denied" ? "GitHub was not approved." : error === "expired_token" ? "The code ran out before GitHub was approved. Connect again." : `GitHub refused: ${error ?? "no token"}`;
    return;
  }
  const token = json.access_token;
  const user = await api<{ login: string }>(token, "/user");
  db.query(
    `INSERT INTO github_connection (id, token, login, connected_by, connected_at, ended_at) VALUES (1, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET token = excluded.token, login = excluded.login, connected_by = excluded.connected_by, connected_at = excluded.connected_at, ended_at = NULL`,
  ).run(token, user.login, p.by, Date.now());
  lastError = undefined;
  cache = null;
}

/** `GET /api/github`: the band (42a–42h). `fresh=1` asks GitHub again for the list. */
export async function githubRoute(c: Context): Promise<Response> {
  const db = getDb();
  const base: GithubState = { configured: githubApp.clientId !== "", state: "off", install_url: githubApp.installUrl };
  if (!base.configured) {
    return c.json(base);
  }
  if (pending) {
    await poll(db).catch((err: unknown) => {
      pending = null;
      lastError = err instanceof Error ? err.message : String(err);
    });
  }
  if (pending) {
    return c.json({ ...base, state: "connecting", code: { user_code: pending.userCode, verification_uri: pending.verificationUri, expires_at: pending.expiresAt } });
  }
  const r = row(db);
  const error = lastError;
  if (r?.token) {
    try {
      const list = await listAll(db, r.token, c.req.query("fresh") === "1");
      return c.json({ ...base, state: "on", login: r.login ?? "", connected_by: actorName(r.connected_by, db), connected_at: r.connected_at ?? 0, accounts: list.accounts, repositories: list.repos.length, error });
    } catch (err) {
      if (!(err instanceof Ended)) {
        return c.json({ ...base, state: "on", login: r.login ?? "", connected_by: actorName(r.connected_by, db), connected_at: r.connected_at ?? 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const after = row(db);
  if (after?.ended_at) {
    return c.json({ ...base, state: "ended", login: after.login ?? "", ended_at: after.ended_at, error });
  }
  return c.json({ ...base, error });
}

/** `POST /api/github/connect`: ask GitHub for a device code (42b). */
export async function githubConnectRoute(c: Context): Promise<Response> {
  if (!githubApp.clientId) {
    return c.json({ error: "This build has no GitHub App client ID" }, 400);
  }
  const json: Record<string, unknown> = await form(`${githubApp.webUrl}/login/device/code`, { client_id: githubApp.clientId }).catch((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
  if (typeof json.device_code !== "string" || typeof json.user_code !== "string") {
    return c.json({ error: `GitHub did not give a code: ${String(json.error_description ?? json.error ?? "no answer")}` }, 502);
  }
  const interval = typeof json.interval === "number" ? json.interval : 5;
  pending = {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: typeof json.verification_uri === "string" ? json.verification_uri : `${githubApp.webUrl}/login/device`,
    expiresAt: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : 900) * 1000,
    interval,
    nextPoll: Date.now() + interval * 1000,
    by: currentActorRef(),
  };
  lastError = undefined;
  return githubRoute(c);
}

/** `DELETE /api/github/connect`: stop waiting for the code. */
export async function githubCancelRoute(c: Context): Promise<Response> {
  pending = null;
  lastError = undefined;
  return githubRoute(c);
}

/** `DELETE /api/github`: forget the token (42f). Repositories set here stay. */
export async function githubDisconnectRoute(c: Context): Promise<Response> {
  const db = getDb();
  db.run("DELETE FROM github_connection WHERE id = 1");
  pending = null;
  lastError = undefined;
  cache = null;
  return githubRoute(c);
}

/** Most repositories one Set menu answer lists. */
const maxListed = 50;

/** `GET /api/github/repositories?q=`: the repositories Set lists under On GitHub (42e). */
export async function githubRepositoriesRoute(c: Context): Promise<Response> {
  const db = getDb();
  const r = row(db);
  if (!githubApp.clientId || !r?.token) {
    return c.json({ repositories: [], matching: 0, total: 0 });
  }
  try {
    const list = await listAll(db, r.token);
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const matching = q ? list.repos.filter((repo) => repo.name.toLowerCase().includes(q)) : list.repos;
    return c.json({ repositories: matching.slice(0, maxListed), matching: matching.length, total: list.repos.length });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err), ended: err instanceof Ended }, err instanceof Ended ? 409 : 502);
  }
}
