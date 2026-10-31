import { hasTwoStep, makeBackupCodes, resetTwoStep, twoStepState } from "./two-step";
import { forgetBrowser, forgetBrowsersOf, rememberCookieName, rememberedBrowsersOf, rememberedSummary } from "./remembered";
import { readCookie } from "../auth";
import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { actorName } from "./actors";
import { getDb } from "./index";
import {
  allPeople,
  agentByName,
  cancelInvite,
  createAgent,
  createInvite,
  createPersonToken,
  createServiceAccount,
  initials,
  isRole,
  openInvites,
  personById,
  revokePersonToken,
  revokePerson,
  roleAtLeast,
  setRole,
  tokensOf,
  type Person,
  type PersonToken,
} from "./people";

/** People in Access (#308, frames 30a, 32e, 32f): people, service accounts, open invites and their tokens. */

function tokenJson(t: PersonToken) {
  return { id: t.id, name: t.name, read_only: t.read_only === 1, created_at: t.created_at, expires_at: t.expires_at, last_used_at: t.last_used_at };
}

function personJson(p: Person, meId: string | null) {
  return {
    id: p.id,
    kind: p.kind,
    agent: p.agent === 1,
    name: p.name,
    email: p.email,
    role: p.role,
    initials: initials(p.name),
    you: p.id === meId,
    signs_in_with: p.kind === "service" ? "tokens only" : p.password_hash ? "password" : "provider",
    last_seen_at: p.last_seen_at,
    created_at: p.created_at,
    invited_by: p.created_by === "owner-link" ? null : actorName(p.created_by)?.name ?? null,
    first_owner: p.created_by === "owner-link",
    tokens: tokensOf(p.id).map(tokenJson),
    two_step: (() => {
      const t = twoStepState(p);
      return { ...t, reset_by: actorName(t.reset_by)?.name ?? null, remembered: rememberedSummary(p.id) };
    })(),
  };
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What an agent saved, under its own name (34c): its monitors, the saved hunts it shared (each a
 * panel on everyone's Home), and the rest (a Viewer's own, boards).
 */
function agentSaved(id: string): { monitors: number; home_panels: number; hunts: number } {
  const db = getDb();
  const monitors = (db.query("SELECT count(*) AS n FROM alert_rules WHERE created_by = ?").get(id) as { n: number }).n;
  const saved = db.query("SELECT board, shared FROM saved_searches WHERE owner_id = ?").all(id) as Array<{ board: string | null; shared: number }>;
  const homePanels = saved.filter((s) => !s.board && s.shared === 1).length;
  return { monitors, home_panels: homePanels, hunts: saved.length - homePanels };
}

function agentJson(p: Person, meId: string | null) {
  return { ...personJson(p, meId), made_on_host: p.created_by === "host", saved: agentSaved(p.id) };
}

/** `GET /api/people`. */
export function listPeopleRoute(c: Context): Response {
  const me = actorOf(c)?.person.id ?? null;
  const people = allPeople().filter((p) => p.revoked_at === null);
  return c.json({
    people: people.filter((p) => p.kind === "person").map((p) => personJson(p, me)),
    service_accounts: people.filter((p) => p.kind === "service" && p.agent !== 1).map((p) => personJson(p, me)),
    agents: people.filter((p) => p.kind === "service" && p.agent === 1).map((p) => agentJson(p, me)),
    invites: openInvites().map((i) => ({ id: i.id, who: i.who, role: i.role, created_at: i.created_at, expires_at: i.expires_at, invited_by: actorName(i.created_by)?.name ?? null })),
  });
}

/** `POST /api/people/invites` `{ who, role, days }` → the link, shown once (30b). */
export async function createInviteRoute(c: Context): Promise<Response> {
  const rec = await body(c);
  if (!rec) {
    return c.json({ error: "Expected an object" }, 400);
  }
  if (!isRole(rec.role)) {
    return c.json({ error: "role is viewer, operator or owner" }, 400);
  }
  const made = createInvite({
    who: typeof rec.who === "string" ? rec.who : "",
    role: rec.role,
    days: typeof rec.days === "number" ? rec.days : undefined,
    created_by: actorOf(c)?.person.id ?? null,
  });
  if ("error" in made) {
    return c.json({ error: made.error }, 400);
  }
  const origin = new URL(c.req.url).origin;
  const forwarded = c.req.header("x-forwarded-host");
  const base = forwarded ? `${c.req.header("x-forwarded-proto") ?? "https"}://${forwarded.split(",")[0]!.trim()}` : origin;
  return c.json({ id: made.invite.id, link: `${base}/join/${made.token}`, expires_at: made.invite.expires_at, role: made.invite.role, who: made.invite.who }, 201);
}

export function cancelInviteRoute(c: Context): Response {
  return cancelInvite(c.req.param("id") ?? "") ? c.json({ ok: true }) : c.json({ error: "No such invite" }, 404);
}

/** `PUT /api/people/:id` `{ role }`. */
export async function putPersonRoute(c: Context): Promise<Response> {
  const rec = await body(c);
  if (!rec || !isRole(rec.role)) {
    return c.json({ error: "role is viewer, operator or owner" }, 400);
  }
  const problem = setRole(c.req.param("id") ?? "", rec.role);
  if (problem) {
    return c.json({ error: problem }, problem === "No such person" ? 404 : 409);
  }
  return c.json(personJson(personById(c.req.param("id") ?? "")!, actorOf(c)?.person.id ?? null));
}

/** `DELETE /api/people/:id`: revoke; sessions and tokens end on the next request. */
export function revokePersonRoute(c: Context): Response {
  const problem = revokePerson(c.req.param("id") ?? "");
  if (problem) {
    return c.json({ error: problem }, problem === "No such person" ? 404 : 409);
  }
  return c.json({ ok: true });
}

/** `POST /api/people/service-accounts` `{ name, role }` (32f). */
export async function createServiceAccountRoute(c: Context): Promise<Response> {
  const rec = await body(c);
  if (!rec || typeof rec.name !== "string" || !isRole(rec.role)) {
    return c.json({ error: "A service account needs a name and a role" }, 400);
  }
  try {
    const account = createServiceAccount({ name: rec.name, role: rec.role, created_by: actorOf(c)?.person.id ?? null });
    return c.json(personJson(account, actorOf(c)?.person.id ?? null), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

/**
 * `POST /api/people/agents` `{ name, role }` (#357, 34a → 34b): an agent and a token, shown once. A
 * Viewer or an Operator; an Owner is refused. The agent that has the name already, in that role,
 * gets another token (as `toposcope.sh agent` does); in another role it is refused.
 */
export async function createAgentRoute(c: Context): Promise<Response> {
  const rec = await body(c);
  if (!rec || typeof rec.name !== "string" || !isRole(rec.role)) {
    return c.json({ error: "An agent needs a name and a role: viewer or operator" }, 400);
  }
  const by = actorOf(c)?.person.id ?? null;
  try {
    const existing = rec.role === "owner" ? null : agentByName(rec.name);
    if (existing && existing.role !== rec.role) {
      return c.json({ error: `${existing.name} is a${existing.role === "operator" ? "n Operator" : " Viewer"}: revoke it first, or name another agent` }, 409);
    }
    const agent = existing ?? createAgent({ name: rec.name, role: rec.role, created_by: by });
    const { token } = createPersonToken(agent.id, { name: "made in Access", created_by: by });
    return c.json({ agent: agentJson(personById(agent.id)!, by), token, kept: existing !== null }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

const dayMs = 24 * 60 * 60_000;

function tokenInput(rec: Record<string, unknown>): { name: string; read_only: boolean; expires_at: number } | { error: string } {
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) {
    return { error: "A token needs a name" };
  }
  const days = typeof rec.expires_in_days === "number" ? rec.expires_in_days : 365;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { error: "A token expires in 1 to 365 days" };
  }
  return { name, read_only: rec.read_only === true, expires_at: Date.now() + days * dayMs };
}

/** `POST /api/me/tokens`: a personal token for my own scripts, shown once (32f, For: Me). */
export async function createMyTokenRoute(c: Context): Promise<Response> {
  const actor = actorOf(c);
  const rec = await body(c);
  if (!actor || !rec) {
    return c.json({ error: "Expected an object" }, 400);
  }
  if (actor.person.kind !== "person" || actor.via !== "session") {
    return c.json({ error: "A personal token is made by its person, signed in" }, 403);
  }
  const input = tokenInput(rec);
  if ("error" in input) {
    return c.json({ error: input.error }, 400);
  }
  const { token, row } = createPersonToken(actor.person.id, { ...input, created_by: actor.person.id });
  return c.json({ token, ...tokenJson(row) }, 201);
}

/** `POST /api/people/:id/tokens`: a service account's token (Owner). */
export async function createServiceTokenRoute(c: Context): Promise<Response> {
  const account = personById(c.req.param("id") ?? "");
  const rec = await body(c);
  if (!account || account.kind !== "service" || account.revoked_at !== null) {
    return c.json({ error: "No such service account" }, 404);
  }
  if (!rec) {
    return c.json({ error: "Expected an object" }, 400);
  }
  const input = tokenInput(rec);
  if ("error" in input) {
    return c.json({ error: input.error }, 400);
  }
  const { token, row } = createPersonToken(account.id, { ...input, created_by: actorOf(c)?.person.id ?? null });
  return c.json({ token, ...tokenJson(row) }, 201);
}

/** `DELETE /api/people/:id/two-step` (32e): an Owner resets a lost phone; set up again at the next sign-in. */
export function resetTwoStepRoute(c: Context): Response {
  const person = personById(c.req.param("id") ?? "");
  if (!person || person.revoked_at !== null || person.kind !== "person") {
    return c.json({ error: "No such person" }, 404);
  }
  resetTwoStep(person.id, actorOf(c)?.person.id ?? null);
  return c.json({ ok: true });
}

/** `POST /api/me/two-step/backup-codes`: ten new codes for me, shown once; the old ten stop working. */
export function newBackupCodesRoute(c: Context): Response {
  const actor = actorOf(c);
  if (!actor || actor.via !== "session" || !hasTwoStep(actor.person.id)) {
    return c.json({ error: "Two-step is not set up for you" }, 400);
  }
  return c.json({ backup_codes: makeBackupCodes(actor.person.id) });
}

/** `GET /api/me/remembered-browsers` (34f): the browsers that skip my code, this one marked. */
export function myRememberedRoute(c: Context): Response {
  const actor = actorOf(c);
  if (!actor || actor.via !== "session") {
    return c.json({ browsers: [] });
  }
  return c.json({ browsers: rememberedBrowsersOf(actor.person.id, readCookie(c.req.header("cookie"), rememberCookieName())) });
}

/** `DELETE /api/me/remembered-browsers/:id`, or every one of mine without an id: the code is asked there again. */
export function forgetMyBrowserRoute(c: Context): Response {
  const actor = actorOf(c);
  if (!actor || actor.via !== "session") {
    return c.json({ error: "Only a signed-in browser has remembered browsers" }, 400);
  }
  const id = c.req.param("id");
  if (!id) {
    return c.json({ ok: true, forgotten: forgetBrowsersOf(actor.person.id) });
  }
  return forgetBrowser(actor.person.id, id) ? c.json({ ok: true, forgotten: 1 }) : c.json({ error: "No such remembered browser" }, 404);
}

/** `DELETE /api/people/:id/remembered-browsers` (34g): an Owner forgets someone's browsers. */
export function forgetPersonBrowsersRoute(c: Context): Response {
  const person = personById(c.req.param("id") ?? "");
  if (!person || person.kind !== "person") {
    return c.json({ error: "No such person" }, 404);
  }
  return c.json({ ok: true, forgotten: forgetBrowsersOf(person.id) });
}

/** `GET /api/me/tokens`: my own tokens. */
export function myTokensRoute(c: Context): Response {
  const actor = actorOf(c);
  return c.json({ tokens: actor ? tokensOf(actor.person.id).map(tokenJson) : [] });
}

/** `DELETE /api/me/tokens/:id`, or an Owner's `DELETE /api/people/:id/tokens/:tid`. */
export function revokeTokenRoute(c: Context): Response {
  const actor = actorOf(c);
  const id = c.req.param("tid") ?? c.req.param("id") ?? "";
  const row = getDb().query("SELECT person_id FROM person_tokens WHERE id = ? AND revoked_at IS NULL").get(id) as { person_id: string } | null;
  if (!row || !actor) {
    return c.json({ error: "No such token" }, 404);
  }
  if (row.person_id !== actor.person.id && !roleAtLeast(actor.role, "owner")) {
    return c.json({ error: "Only its person, or an Owner, may revoke a token", need: "owner" }, 403);
  }
  revokePersonToken(id);
  return c.json({ ok: true });
}
