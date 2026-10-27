import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "./index";
import { isRole, looksLikeEmail, normalEmail, personByEmail, personById, type Person, type Role } from "./people";

/**
 * Sign in with one OIDC provider (#310, frames 30c and 30d), in the open-source edition on purpose.
 * Authorization code with PKCE, discovery from the issuer, the ID token checked against the
 * provider's keys, a verified email, the allowed domain. One provider: Google Workspace, Entra,
 * Okta, Keycloak, Authentik or any other that speaks OIDC.
 */

export const providerPresets = ["google", "entra", "okta", "keycloak", "authentik", "other"] as const;
export type ProviderPreset = (typeof providerPresets)[number];
export const presetNames: Record<ProviderPreset, string> = {
  google: "Google Workspace",
  entra: "Microsoft Entra",
  okta: "Okta",
  keycloak: "Keycloak",
  authentik: "Authentik",
  other: "OIDC",
};

export type WithoutInvite = "viewer" | "operator" | "none";

export type OidcConfig = {
  preset: ProviderPreset;
  /** The words on the button: "Google", "Acme Okta". */
  label: string;
  issuer: string;
  client_id: string;
  /** Sealed at rest; never returned. */
  client_secret: string | null;
  allowed_domain: string | null;
  without_invite: WithoutInvite;
};

export type SignInSettings = {
  oidc: (Omit<OidcConfig, "client_secret"> & { secret_set_at: number | null }) | null;
  passwords: boolean;
  status: { last_sign_in_at: number | null; last_error: string | null; last_error_at: number | null };
};

export function migrateOidc(db: Database, addColumn: (db: Database, table: string, column: string, type: string) => void): void {
  addColumn(db, "people", "oidc_sub", "TEXT");
  db.run(`
    CREATE TABLE IF NOT EXISTS oidc_states (
      state TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      next TEXT,
      invite TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function key(db: Database): Buffer {
  const row = db.query("SELECT value FROM settings WHERE key = 'session_secret'").get() as { value: string } | null;
  return createHash("sha256").update(`toposcope-oidc\0${process.env.TOPOSCOPE_SESSION_SECRET ?? row?.value ?? ""}`).digest();
}

function seal(plain: string, db: Database): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(db), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function unseal(sealed: string, db: Database): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(db), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function read(name: string, db: Database): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(name) as { value: string } | null;
  return row?.value ?? null;
}

function write(name: string, value: string | null, db: Database): void {
  if (value === null) {
    db.query("DELETE FROM settings WHERE key = ?").run(name);
    return;
  }
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name, value);
}

export function oidcConfig(db: Database = getDb()): OidcConfig | null {
  const raw = read("oidc", db);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as OidcConfig;
    return { ...parsed, client_secret: parsed.client_secret ? unseal(parsed.client_secret, db) : null };
  } catch {
    return null;
  }
}

export function passwordsOn(db: Database = getDb()): boolean {
  return read("passwords", db) !== "off";
}

export function signInSettings(db: Database = getDb()): SignInSettings {
  const config = oidcConfig(db);
  const status = JSON.parse(read("oidc_status", db) ?? "{}") as Partial<SignInSettings["status"]>;
  const secretAt = Number(read("oidc_secret_at", db)) || null;
  return {
    oidc: config ? { preset: config.preset, label: config.label, issuer: config.issuer, client_id: config.client_id, allowed_domain: config.allowed_domain, without_invite: config.without_invite, secret_set_at: config.client_secret ? secretAt : null } : null,
    passwords: passwordsOn(db),
    status: { last_sign_in_at: status.last_sign_in_at ?? null, last_error: status.last_error ?? null, last_error_at: status.last_error_at ?? null },
  };
}

function noteStatus(patch: Partial<SignInSettings["status"]>, db: Database): void {
  const now = JSON.parse(read("oidc_status", db) ?? "{}") as Record<string, unknown>;
  write("oidc_status", JSON.stringify({ ...now, ...patch }), db);
}

/** Owners who could still sign in if passwords were off: those the provider knows. */
function ownersWithoutProvider(db: Database): number {
  const row = db
    .query("SELECT count(*) AS n FROM people WHERE role = 'owner' AND kind = 'person' AND revoked_at IS NULL AND oidc_sub IS NULL")
    .get() as { n: number };
  return row.n;
}

/** `PUT /api/sign-in-settings`: what the Owner set, checked; the client secret only when sent. */
export function writeSignInSettings(rec: Record<string, unknown>, now = Date.now(), db: Database = getDb()): SignInSettings | { error: string } {
  if (rec.oidc === null) {
    if (!passwordsOn(db)) {
      return { error: "Turn passwords on before removing the provider: nobody could sign in" };
    }
    write("oidc", null, db);
  } else if (rec.oidc !== undefined) {
    if (!rec.oidc || typeof rec.oidc !== "object") {
      return { error: "oidc is an object, or null to remove it" };
    }
    const o = rec.oidc as Record<string, unknown>;
    const before = oidcConfig(db);
    const preset = (providerPresets as readonly string[]).includes(String(o.preset)) ? (o.preset as ProviderPreset) : "other";
    const issuer = typeof o.issuer === "string" ? o.issuer.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\/[^\s]+$/.test(issuer)) {
      return { error: "The issuer is the provider's https URL, as its discovery document names it" };
    }
    if (issuer.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|[^/]+\.test)(:\d+)?(\/|$)/.test(issuer)) {
      return { error: "The issuer must be https" };
    }
    const clientId = typeof o.client_id === "string" ? o.client_id.trim() : "";
    if (!clientId) {
      return { error: "The client id comes from the provider's app registration" };
    }
    const secret = typeof o.client_secret === "string" && o.client_secret.trim() ? o.client_secret.trim() : (before?.client_secret ?? null);
    if (!secret) {
      return { error: "The client secret comes from the provider's app registration" };
    }
    const domainRaw = typeof o.allowed_domain === "string" ? o.allowed_domain.trim().toLowerCase().replace(/^@/, "") : "";
    if (domainRaw && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainRaw)) {
      return { error: "The allowed domain is like example.com, or empty for any" };
    }
    const without = o.without_invite === "operator" || o.without_invite === "none" ? o.without_invite : "viewer";
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 40) : presetNames[preset];
    write(
      "oidc",
      JSON.stringify({ preset, label, issuer, client_id: clientId, client_secret: seal(secret, db), allowed_domain: domainRaw || null, without_invite: without }),
      db,
    );
    if (typeof o.client_secret === "string" && o.client_secret.trim()) {
      write("oidc_secret_at", String(now), db);
    }
    discovered.delete(issuer);
  }
  if (rec.passwords !== undefined) {
    if (typeof rec.passwords !== "boolean") {
      return { error: "passwords is true or false" };
    }
    if (!rec.passwords) {
      if (!oidcConfig(db)) {
        return { error: "Passwords cannot be off without a provider to sign in with" };
      }
      if (ownersWithoutProvider(db) > 0) {
        return { error: "Every Owner must have signed in with the provider once before passwords go off" };
      }
    }
    write("passwords", rec.passwords ? "on" : "off", db);
  }
  return signInSettings(db);
}

// ---- The flow ----

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
const discovered = new Map<string, { at: number; doc: Discovery }>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discovered.get(issuer);
  if (hit && Date.now() - hit.at < 60 * 60_000) {
    return hit.doc;
  }
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`the provider's discovery document answered ${res.status}`);
  }
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("the provider's discovery document has no authorization, token or keys endpoint");
  }
  discovered.set(issuer, { at: Date.now(), doc });
  return doc;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Where the browser goes to sign in at the provider, and what this instance keeps to finish. */
export async function startSignIn(redirectUri: string, next: string, invite: string | null, now = Date.now(), db: Database = getDb()): Promise<string> {
  const config = oidcConfig(db);
  if (!config) {
    throw new Error("No provider is set up");
  }
  const doc = await discover(config.issuer);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  db.query("DELETE FROM oidc_states WHERE created_at < ?").run(now - 10 * 60_000);
  db.query("INSERT INTO oidc_states (state, verifier, nonce, next, invite, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(state, verifier, nonce, next, invite, now);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.allowed_domain && config.preset === "google") {
    url.searchParams.set("hd", config.allowed_domain);
  }
  return url.toString();
}

type Claims = { iss: string; aud: string | string[]; exp: number; iat?: number; nonce?: string; sub: string; email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string };

async function verifyIdToken(token: string, doc: Discovery, config: OidcConfig, nonce: string): Promise<Claims> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) {
    throw new Error("the ID token is not a JWT");
  }
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg: string; kid?: string };
  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new Error(`the ID token is signed with ${header.alg}; RS256 or ES256 is expected`);
  }
  const jwks = (await (await fetch(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as { keys: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const jwk = jwks.keys.find((k) => (header.kid ? k.kid === header.kid : true) && (k.kty === (header.alg === "RS256" ? "RSA" : "EC")));
  if (!jwk) {
    throw new Error("the ID token's key is not among the provider's keys");
  }
  const algorithm = header.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const ok = await crypto.subtle.verify(algorithm, key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) {
    throw new Error("the ID token's signature is not the provider's");
  }
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Claims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss.replace(/\/+$/, "") !== config.issuer && claims.iss !== doc.issuer) {
    throw new Error("the ID token is from another issuer");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.client_id)) {
    throw new Error("the ID token is for another client");
  }
  if (claims.exp + 60 < now) {
    throw new Error("the ID token has expired");
  }
  if (claims.nonce !== nonce) {
    throw new Error("the ID token's nonce does not match this sign-in");
  }
  return claims;
}

export type Finished =
  | { ok: true; person: Person; next: string; created: boolean }
  | { ok: false; error: string };

/** Finishes a sign-in at the provider: the person it matches, makes from an invite, or refuses. */
export async function finishSignIn(
  input: { code: string; state: string; redirectUri: string },
  inviteJoin: (token: string, person: { name: string; email: string; sub: string }) => Person | { error: string },
  now = Date.now(),
  db: Database = getDb(),
): Promise<Finished> {
  const config = oidcConfig(db);
  if (!config) {
    return { ok: false, error: "No provider is set up" };
  }
  const row = db.query("SELECT * FROM oidc_states WHERE state = ?").get(input.state) as
    | { state: string; verifier: string; nonce: string; next: string | null; invite: string | null; created_at: number }
    | null;
  db.query("DELETE FROM oidc_states WHERE state = ?").run(input.state);
  if (!row || now - row.created_at > 10 * 60_000) {
    return { ok: false, error: "This sign-in took too long or was not started here. Start again." };
  }
  try {
    const doc = await discover(config.issuer);
    const res = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: config.client_id,
        client_secret: config.client_secret ?? "",
        code_verifier: row.verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.id_token) {
      throw new Error(`the provider refused the code: ${body.error_description ?? body.error ?? res.status}`);
    }
    const claims = await verifyIdToken(body.id_token, doc, config, row.nonce);
    const email = claims.email ? normalEmail(claims.email) : "";
    if (!looksLikeEmail(email) || !(claims.email_verified === true || claims.email_verified === "true")) {
      throw new Error("the provider did not give a verified email");
    }
    if (config.allowed_domain && !email.endsWith(`@${config.allowed_domain}`)) {
      return { ok: false, error: `Only ${config.allowed_domain} addresses sign in here` };
    }
    const name = claims.name ?? claims.preferred_username ?? email.split("@")[0]!;
    const next = row.next ?? "/";
    const bySub = db.query("SELECT id FROM people WHERE oidc_sub = ? AND revoked_at IS NULL").get(claims.sub) as { id: string } | null;
    let person = bySub ? personById(bySub.id, db) : null;
    if (!person) {
      const byEmail = personByEmail(email, db);
      if (byEmail && byEmail.revoked_at === null && byEmail.kind === "person") {
        db.query("UPDATE people SET oidc_sub = ? WHERE id = ?").run(claims.sub, byEmail.id);
        person = personById(byEmail.id, db);
      }
    }
    if (person) {
      noteStatus({ last_sign_in_at: now }, db);
      return { ok: true, person, next, created: false };
    }
    if (row.invite) {
      const joined = inviteJoin(row.invite, { name, email, sub: claims.sub });
      if ("error" in joined) {
        return { ok: false, error: joined.error };
      }
      noteStatus({ last_sign_in_at: now }, db);
      return { ok: true, person: joined, next, created: true };
    }
    if (config.without_invite === "none") {
      return { ok: false, error: `${email} has no invite here. Ask an Owner for one.` };
    }
    const role: Role = isRole(config.without_invite) ? config.without_invite : "viewer";
    const id = randomUUID();
    db.query("INSERT INTO people (id, kind, name, email, role, oidc_sub, created_at, created_by) VALUES (?, 'person', ?, ?, ?, ?, ?, 'provider')").run(id, name, email, role, claims.sub, now);
    noteStatus({ last_sign_in_at: now }, db);
    return { ok: true, person: personById(id, db)!, next, created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    noteStatus({ last_error: message, last_error_at: now }, db);
    return { ok: false, error: `Sign-in with ${config.label} did not finish: ${message}` };
  }
}
