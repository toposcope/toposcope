import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { sessionEnd } from "../auth";
import { insertEvents } from "../ingest";
import { openedAddress, redirectUri } from "../shared/request-address";
import { stampSetting } from "./actors";
import { instanceId, instanceName } from "./instance";
import { signInSettings, writeSignInSettings } from "./oidc";
import { allPeople, initials, meBody } from "./people";
import { checkReleasesNow, versionReply, type CheckDeps, type VersionReply } from "./release-check";
import { storeSize } from "./store-size";
import { twoStepFor, writeTwoStepFor } from "./two-step";
import { announceNewRelease } from "./update-event";
import { readUpgrader, requestUpgrade } from "./upgrader";

export function meRoute(c: Context): Response {
  const actor = actorOf(c);
  if (!actor) {
    return c.json({ error: "Sign in" }, 401);
  }
  // 30e: "ask an Owner" names them.
  const owners = allPeople().filter((p) => p.role === "owner" && p.kind === "person" && p.revoked_at === null).map((p) => p.name);
  return c.json({ ...meBody(actor), initials: initials(actor.person.name), owners });
}

export function instanceRoute(c: Context): Response {
  const expiresAt = actorOf(c)?.via === "token" ? null : sessionEnd(c.req.header("cookie"));
  return c.json({
    id: instanceId(),
    name: instanceName(),
    address: openedAddress(c),
    session: expiresAt === null ? { kind: "token" } : { kind: "cookie", expires_at: expiresAt },
  });
}

// A version seen for the first time writes one event:update_available row, to page on (#197).
export const releaseCheckDeps: CheckDeps = {
  onChecked: (releases, running) => announceNewRelease(releases, running, { write: insertEvents }),
};

// The stores are sized only when an upgrade is on offer: the panel says how big its backup is (#201).
async function versionBody(reply: VersionReply): Promise<VersionReply> {
  const upgrader = readUpgrader();
  return reply.releases.length > 0 ? { ...reply, store: await storeSize(), upgrader } : { ...reply, upgrader };
}

// Signed in, unlike /api/health: how far behind an instance is stays with its operators (#196).
export async function versionRoute(c: Context): Promise<Response> {
  return c.json(await versionBody(versionReply()));
}

// Check now (#219): one check by hand, on top of the daily one.
export async function versionCheckRoute(c: Context): Promise<Response> {
  return c.json(await versionBody(await checkReleasesNow(releaseCheckDeps)));
}

// Upgrade from here (#220): the app writes a request into its own volume; the host's upgrade.sh runs it.
export async function versionUpgradeRoute(c: Context): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
  const known = versionReply().releases.map((r) => r.version);
  const answer = requestUpgrade(body?.version, known);
  return c.json(answer.body, answer.status);
}

export function signInSettingsRoute(c: Context): Response {
  return c.json({ ...signInSettings(), redirect_uri: redirectUri(c), two_step_for: twoStepFor() });
}

export async function putSignInSettingsRoute(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  const rec = body as Record<string, unknown>;
  if (rec.two_step_for !== undefined) {
    if (rec.two_step_for !== "everyone" && rec.two_step_for !== "owners") {
      return c.json({ error: "two_step_for is everyone or owners" }, 400);
    }
    writeTwoStepFor(rec.two_step_for);
    stampSetting("two_step_for");
  }
  const out = writeSignInSettings(rec);
  if ("error" in out) {
    return c.json({ error: out.error }, 400);
  }
  stampSetting("sign_in");
  return c.json({ ...out, redirect_uri: redirectUri(c), two_step_for: twoStepFor() });
}
