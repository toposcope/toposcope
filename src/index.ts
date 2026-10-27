import type { Server } from "bun";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { startAlertCron } from "./alerts/cron";
import { startHttpMonitors } from "./alerts/http-cron";
import { checkBearer, ingestTokenName, isBasic, readCookie, resolveActor, sessionCookieHeader, sessionCookieName, sessionEnd } from "./auth";
import { actorOf, setActor } from "./actor-context";
import { runAs } from "./control/actors";
import { actionFor, actionRole, refusalWords } from "./control/roles";
import {
  checkPassword,
  clearSignInFailures,
  createSession,
  endSession,
  initials,
  liveOwnerCount,
  looksLikeEmail,
  meBody,
  roleAtLeast,
  noteSignInFailure,
  ownerLinkFor,
  sessionMs,
  signInWaitMs,
  useOwnerLink,
  inviteFor,
  useInviteWithProvider,
  pendingMs,
  sessionAtStage,
  setSessionStage,
  type Person,
  type SessionStage,
  useInvite,
} from "./control/people";
import { actorName } from "./control/actors";
import { getDb, getHealth } from "./control";
import { importEnvIngestToken } from "./control/tokens";
import {
  cancelInviteRoute,
  createInviteRoute,
  createMyTokenRoute,
  createServiceAccountRoute,
  createServiceTokenRoute,
  listPeopleRoute,
  myTokensRoute,
  putPersonRoute,
  revokePersonRoute,
  revokeTokenRoute,
  resetTwoStepRoute,
  newBackupCodesRoute,
} from "./control/people-routes";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
} from "./control/alerts";
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  runSavedSearch,
  testSavedSearch,
  updateSavedSearch,
} from "./control/saved-searches";
import { getFields, putFields, storedSkipKeys } from "./control/fields";
import { effectiveMetricsRetentionDays, getRetentionDays, getSettings, putSettings } from "./control/settings";
import { instanceId, instanceName } from "./control/instance";
import { setHereName } from "./shared/here";
import { getHome, homeSaved, putHome } from "./control/home";
import { homeSinceRoute } from "./control/home-since";
import { version as runningVersionForSignIn } from "./shared/version";
import { monitorPreviewRoute } from "./alerts/preview";
import { fingerprintSeenRoute } from "./query/fingerprint-seen";
import { savedSearchUrl } from "./ui/search-url";
import { joinPageHtml, ownerSetupPageHtml, safeNext, signInPageHtml, twoStepPageHtml, type TwoStepPageBody } from "./sign-in-page";
import { beginSetup, checkSecondStep, confirmSetup, groupedKey, hasTwoStep, makeBackupCodes, otpauthUri, twoStepFor, twoStepRequired, writeTwoStepFor } from "./control/two-step";
import { finishSignIn, oidcConfig, passwordsOn, signInSettings, startSignIn, writeSignInSettings } from "./control/oidc";
import { stampSetting } from "./control/actors";
import { qrSvg } from "./shared/qr";
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
} from "./control/tokens";
import { ingestRoute, insertEvents } from "./ingest";
import { ingestMetricsRoute } from "./ingest/metrics";
import { ingestMarksRoute } from "./ingest/marks";
import { ingestProbesRoute } from "./ingest/probes";
import { ingestChecksRoute, pingRoute } from "./ingest/checks";
import { otlpLogsRoute } from "./ingest/otlp-route";
import { otlpTracesRoute } from "./ingest/otlp-traces-route";
import { otlpProfilesRoute } from "./ingest/otlp-profiles-route";
import { startOtlpGrpc } from "./ingest/otlp-grpc";
import { startSyslogUdp } from "./ingest/syslog";
import { renderMetrics } from "./metrics";
import { attrFacetsRoute, attrKeysRoute, attrValuesRoute, aroundTsRoute, facetsRoute, metricNamesRoute,
  metricLabelsRoute, numericKeysRoute, searchRoute, surroundingRoute } from "./query";
import { fingerprintCutRoute, fingerprintRevisionsRoute } from "./query/fingerprint-cut";
import { createFeedRoute, listFeedsRoute, readFeedRoute } from "./feed/feed";
import { claimRoute, linkAskRoute, linkFeedRoute, linkRemoveRoute, linkRowsRoute, lookupRoute } from "./links/protocol";
import {
  confirmRoute,
  inviteRoute,
  listLinksRoute,
  offerRoute,
  previewRoute,
  removeLinkRoute,
  revokeKeyRoute,
} from "./links/operator";
import { startLinkPuller } from "./links/puller";
import { loadArrivalSeq } from "./ingest/arrival-seq";
import { followSpanRoute } from "./query/follow-span";
import { testAlertCallRoute } from "./alerts/test-call";
import { deleteMonitor, getMonitor, listMonitors, putMonitor, updateMonitorRoute } from "./control/monitors";
import { sendHttpRoute } from "./control/http-monitors";
import { tracesRoute } from "./query/traces";
import { marksRoute } from "./query/marks";
import { probesRoute } from "./query/probes";
import { profilesRoute } from "./query/profiles";
import { systemRoute } from "./query/system";
import { throughputRoute } from "./query/throughput";
import { applyRetentionDays, migrateStore, syncFieldRoleSkip } from "./shared/migrate";
import { requirePackagedSecrets } from "./shared/secrets";
import { requirePublicUrl } from "./shared/public-url";
import { requireWatchdogUrl } from "./alerts/watchdog";
import { checkReleasesNow, startReleaseCheck, versionReply, type CheckDeps, type VersionReply } from "./control/release-check";
import { announceNewRelease } from "./control/update-event";
import { storeSize } from "./control/store-size";
import { readUpgrader, requestUpgrade } from "./control/upgrader";
import { bootAllowsRequest, type BootPhase } from "./shared/boot";
import { createShareRoute, listSharesRoute, previewTicketRoute, putShareRoute, revokeShareRoute, shareAuth, ticketRoute } from "./share/operator";
import { shareNamesRoute, shareReadCache, shareSeriesRoute, sharePanelRoute, shareTopRoute } from "./share/read";
import { embedAssetRoute, embedJsRoute, embedPageRoute } from "./share/embed-page";
import { noFraming } from "./share/embed";
import { startShareUse } from "./share/use";
import { noteAccessRefused, noteAccessUsed, startAccessUse } from "./access/use";
import { accessRoute } from "./access/list";
import { linkPageRoute, updateLinkRoute } from "./links/page";

requirePackagedSecrets();
if (process.env.TOPOSCOPE_PASSWORD) {
  console.warn("TOPOSCOPE_PASSWORD is ignored since 0.9: there is no shared password. Make an Owner with ./toposcope.sh owner-link <email>, then delete it from .env.");
}
requirePublicUrl();
requireWatchdogUrl();

let bootPhase: BootPhase = "starting";
/** Set by SIGTERM or SIGINT: the process is finishing what it has and takes nothing new. */
let stopping = false;
let server: Server<unknown> | undefined;
let stopSyslog: () => Promise<void> = async () => {};
let stopGrpc: () => Promise<void> = async () => {};

const app = new Hono();

// First, so it covers every route: a request on a connection that was already
// open is turned away while the process stops. A sender retries a 503.
app.use("/*", async (c, next) => {
  if (stopping) {
    return c.json({ error: "Stopping" }, 503, {
      connection: "close",
      "retry-after": "1",
    });
  }
  return next();
});

// Nothing frames Toposcope but an embed (#227), which sends its share's own frame rules.
app.use("/*", noFraming);

app.onError((err, c) => {
  console.error(err);
  const message = err instanceof Error ? err.message : "Internal error";
  return c.json({ error: message.slice(0, 500) }, 500);
});

app.get("/api/health", async (c) => {
  const health = await getHealth(bootPhase);
  return c.json(health, health.ok ? 200 : 503);
});

app.get("/api/metrics", (c) => {
  return c.text(renderMetrics(), 200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

/** The address the browser opened: what the sign-in page and the tab title name when unnamed. */
function openedAddress(c: Context): string {
  return (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]!.trim() || "toposcope";
}

function overHttps(c: Context): boolean {
  return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || c.req.url.startsWith("https:");
}

let seenOriginAt = 0;
/** The address browsers open, so `owner-link` on the host prints a link that opens here. */
function noteSeenOrigin(c: Context): void {
  const now = Date.now();
  if (now - seenOriginAt < 60_000) {
    return;
  }
  seenOriginAt = now;
  const value = `${overHttps(c) ? "https" : "http"}://${openedAddress(c)}`;
  try {
    getDb().query("INSERT INTO settings (key, value) VALUES ('seen_origin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  } catch {
    // not worth failing a page over
  }
}

/** A browser asking for a page, not a script or the app's own API calls. */
function wantsPage(c: Context): boolean {
  const path = c.req.path;
  return (
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    !path.startsWith("/api/") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/v1development/") &&
    (c.req.header("accept") ?? "").includes("text/html")
  );
}

function signInPage(c: Context, opts: { wrong?: boolean; next?: string; status?: 200 | 401 | 429; email?: string; wait?: number; providerError?: string; passwordsOff?: boolean }): Response {
  const url = new URL(c.req.url);
  const signedOut = url.searchParams.get("signed_out") === "1";
  if (url.searchParams.has("signed_out")) {
    url.searchParams.delete("signed_out");
  }
  return c.html(
    signInPageHtml({
      name: instanceName(),
      address: openedAddress(c),
      next: opts.next ?? `${url.pathname}${url.search}`,
      wrong: opts.wrong,
      signedOut,
      version: runningVersionForSignIn,
      email: opts.email,
      waitSeconds: opts.wait,
      noOwner: liveOwnerCount() === 0,
      provider: oidcConfig() ? { label: oidcConfig()!.label, domain: oidcConfig()!.allowed_domain } : null,
      passwords: passwordsOn(),
      providerError: opts.providerError,
    }),
    opts.status ?? 401,
  );
}

/**
 * Starts a session after a password (#309): straight in, or waiting on the second step, or on
 * setting it up when this person must have one and has none yet.
 */
function beginSession(c: Context, person: Person, next: string): { stage: SessionStage; expiresAt: number } {
  const stage: SessionStage = hasTwoStep(person.id) ? "verify" : twoStepRequired(person) ? "setup" : "full";
  const session = createSession(person, Date.now(), undefined, stage, next);
  c.header("Set-Cookie", sessionCookieHeader(session.value, Math.floor((stage === "full" ? sessionMs : pendingMs) / 1000), overHttps(c)));
  return { stage, expiresAt: session.expiresAt };
}

function twoStepPage(c: Context, page: TwoStepPageBody, status: 200 | 400 | 429 = 200): Response {
  return c.html(twoStepPageHtml({ ...page, name: instanceName(), address: openedAddress(c) }), status);
}

function waitingSession(c: Context) {
  return sessionAtStage(readCookie(c.req.header("cookie"), sessionCookieName()));
}

function setupPage(c: Context, person: Person, error?: string): Response {
  const secret = beginSetup(person.id);
  const account = person.email ?? person.name;
  return twoStepPage(c, { stage: "setup", email: account, secretGrouped: groupedKey(secret), qr: qrSvg(otpauthUri(secret, account, instanceName() ?? openedAddress(c)), 6), error }, error ? 400 : 200);
}

function redirectUri(c: Context): string {
  const env = process.env.TOPOSCOPE_PUBLIC_URL?.replace(/\/+$/, "");
  return `${env ?? `${overHttps(c) ? "https" : "http"}://${openedAddress(c)}`}/auth/callback`;
}

// #310: sign in with the provider. The browser goes there and comes back to /auth/callback.
app.get("/auth/start", async (c) => {
  const next = safeNext(c.req.query("next") ?? "/");
  const invite = c.req.query("invite") ?? null;
  try {
    return c.redirect(await startSignIn(redirectUri(c), next, invite), 302);
  } catch (err) {
    return signInPage(c, { next, providerError: err instanceof Error ? err.message : String(err), status: 200 });
  }
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    const why = c.req.query("error_description") ?? c.req.query("error") ?? "the provider sent no code";
    return signInPage(c, { providerError: `Sign-in did not finish: ${why}`, status: 401 });
  }
  const done = await finishSignIn({ code, state, redirectUri: redirectUri(c) }, (token, person) => useInviteWithProvider(token, person));
  if (!done.ok) {
    noteAccessRefused("person", "provider", done.error, c.req.path);
    return signInPage(c, { providerError: done.error, status: 401 });
  }
  noteAccessUsed("person", done.person.email ?? done.person.name);
  // The provider is the second step for people it signs in (its own MFA applies).
  const session = createSession(done.person);
  c.header("Set-Cookie", sessionCookieHeader(session.value, Math.floor(sessionMs / 1000), overHttps(c)));
  return c.redirect(safeNext(done.next), 303);
});

// 32b–32d: the second step, and setting it up.
app.get("/two-step", (c) => {
  const waiting = waitingSession(c);
  if (!waiting || waiting.stage === "full") {
    return c.redirect("/", 303);
  }
  if (waiting.stage === "setup") {
    return setupPage(c, waiting.person);
  }
  if (waiting.stage === "codes") {
    // Shown once: a reload before Finish makes ten new ones, and the earlier ten stop working.
    return twoStepPage(c, { stage: "codes", email: waiting.person.email ?? waiting.person.name, codes: makeBackupCodes(waiting.person.id) });
  }
  return twoStepPage(c, { stage: "verify", email: waiting.person.email ?? waiting.person.name, backup: c.req.query("backup") === "1" });
});

async function formOrJson(c: Context): Promise<{ json: boolean; body: Record<string, unknown> }> {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  try {
    return { json, body: json ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>) };
  } catch {
    return { json, body: {} };
  }
}

app.post("/api/two-step/verify", async (c) => {
  const { json, body } = await formOrJson(c);
  const waiting = waitingSession(c);
  if (!waiting || waiting.stage !== "verify") {
    return json ? c.json({ error: "Sign in again" }, 401) : c.redirect("/", 303);
  }
  const email = waiting.person.email ?? waiting.person.name;
  const wait = signInWaitMs(email);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    return json
      ? c.json({ error: `Try again in ${seconds} seconds`, retry_after: seconds }, 429)
      : twoStepPage(c, { stage: "verify", email, backup: typeof body.backup === "string", waitSeconds: seconds }, 429);
  }
  const code = typeof body.code === "string" ? body.code : undefined;
  const backup = typeof body.backup === "string" ? body.backup : undefined;
  const result = checkSecondStep(waiting.person.id, { code, backup });
  if (!result.ok) {
    noteSignInFailure(email);
    noteAccessRefused("person", email, "a second step that was not right", c.req.path);
    const nextWait = Math.ceil(signInWaitMs(email) / 1000);
    return json
      ? c.json({ error: "That code was not right" }, 401)
      : twoStepPage(c, { stage: "verify", email, backup: backup !== undefined, wrong: true, waitSeconds: nextWait || undefined }, 400);
  }
  clearSignInFailures(email);
  setSessionStage(waiting.id, "full");
  const next = safeNext(waiting.next ?? "/");
  if (result.via === "backup") {
    return json ? c.json({ ok: true, backup_codes_left: result.left }) : twoStepPage(c, { stage: "backup-used", email, left: result.left, next });
  }
  return json ? c.json({ ok: true }) : c.redirect(next, 303);
});

app.post("/api/two-step/setup", async (c) => {
  const { json, body } = await formOrJson(c);
  const waiting = waitingSession(c);
  if (!waiting || waiting.stage !== "setup") {
    return json ? c.json({ error: "Sign in again" }, 401) : c.redirect("/", 303);
  }
  const codes = confirmSetup(waiting.person.id, typeof body.code === "string" ? body.code : "");
  if (!codes) {
    return json ? c.json({ error: "That code was not right" }, 400) : setupPage(c, waiting.person, "That code was not right. Type the six digits your app shows now.");
  }
  setSessionStage(waiting.id, "codes");
  return json ? c.json({ ok: true, backup_codes: codes }) : twoStepPage(c, { stage: "codes", email: waiting.person.email ?? waiting.person.name, codes });
});

app.post("/api/two-step/finish", async (c) => {
  const { json, body } = await formOrJson(c);
  const waiting = waitingSession(c);
  if (!waiting || waiting.stage !== "codes") {
    return json ? c.json({ error: "Sign in again" }, 401) : c.redirect("/", 303);
  }
  if (!json && body.saved !== "on") {
    return twoStepPage(c, { stage: "codes", email: waiting.person.email ?? waiting.person.name, codes: makeBackupCodes(waiting.person.id), error: "Tick the box once the codes are somewhere safe. These are ten new ones; the earlier ten no longer work." }, 400);
  }
  setSessionStage(waiting.id, "full");
  return json ? c.json({ ok: true }) : c.redirect(safeNext(waiting.next ?? "/"), 303);
});

// #305: a person signs in with their email and password; there is no shared password.
app.post("/api/sign-in", async (c) => {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  let email = "";
  let password = "";
  let nextPath = "/";
  try {
    const body = json ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    email = typeof body.email === "string" ? body.email.trim() : "";
    password = typeof body.password === "string" ? body.password : "";
    nextPath = safeNext(typeof body.next === "string" ? body.next : "/");
  } catch {
    return c.json({ error: "Expected an email and a password" }, 400);
  }
  if (!looksLikeEmail(email) || !password) {
    return json ? c.json({ error: "Expected an email and a password" }, 400) : signInPage(c, { wrong: true, next: nextPath, email });
  }
  if (!passwordsOn()) {
    return json ? c.json({ error: "Passwords are off here: sign in with the provider" }, 401) : signInPage(c, { next: nextPath, status: 401 });
  }
  const wait = signInWaitMs(email);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    return json
      ? c.json({ error: `Too many misses: try again in ${seconds} seconds`, retry_after: seconds }, 429, { "retry-after": String(seconds) })
      : signInPage(c, { next: nextPath, email, wait: seconds, status: 429 });
  }
  const person = await checkPassword(email, password);
  if (!person) {
    noteSignInFailure(email);
    noteAccessRefused("person", email.toLowerCase(), "wrong email or password", c.req.path);
    return json ? c.json({ error: "Wrong email or password" }, 401) : signInPage(c, { wrong: true, next: nextPath, email });
  }
  clearSignInFailures(email);
  noteAccessUsed("person", person.email ?? person.name);
  const started = beginSession(c, person, nextPath);
  if (started.stage !== "full") {
    return json ? c.json({ ok: true, next: "two-step", stage: started.stage }) : c.redirect("/two-step", 303);
  }
  return json ? c.json({ ok: true, expires_at: started.expiresAt }) : c.redirect(nextPath, 303);
});

// 32a: the page an owner link opens. The link is printed by `toposcope.sh owner-link <email>` on
// the host and nowhere else; it makes the first Owner, or gives an Owner a new password.
app.get("/setup/:token", (c) => {
  const link = ownerLinkFor(c.req.param("token"));
  return c.html(
    ownerSetupPageHtml({
      name: instanceName(),
      address: openedAddress(c),
      token: c.req.param("token"),
      email: link?.email ?? null,
      resets: Boolean(link?.person),
      minutesLeft: link ? Math.max(1, Math.round((link.expires_at - Date.now()) / 60_000)) : 0,
    }),
    link ? 200 : 410,
  );
});

// 30c right: the page an invite link opens.
app.get("/join/:token", (c) => {
  const invite = inviteFor(c.req.param("token"));
  return c.html(
    joinPageHtml({
      name: instanceName(),
      address: openedAddress(c),
      token: c.req.param("token"),
      provider: oidcConfig() ? { label: oidcConfig()!.label, domain: oidcConfig()!.allowed_domain } : null,
      passwords: passwordsOn(),
      invite: invite ? { who: invite.who, role: invite.role, inviter: actorName(invite.created_by)?.name ?? null, daysLeft: Math.max(1, Math.ceil((invite.expires_at - Date.now()) / 86_400_000)) } : null,
    }),
    invite ? 200 : 410,
  );
});

app.post("/api/join", async (c) => {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  let token = "";
  let name = "";
  let email = "";
  let password = "";
  try {
    const body = json ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    token = typeof body.token === "string" ? body.token : "";
    name = typeof body.name === "string" ? body.name : "";
    email = typeof body.email === "string" ? body.email : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return c.json({ error: "Expected the invite's token, a name and a password" }, 400);
  }
  const invite = inviteFor(token);
  const done = await useInvite(token, { name, email, password });
  if ("error" in done) {
    if (json) {
      return c.json({ error: done.error }, invite ? 400 : 410);
    }
    return c.html(
      joinPageHtml({
        name: instanceName(),
        address: openedAddress(c),
        token,
        invite: invite ? { who: invite.who, role: invite.role, inviter: actorName(invite.created_by)?.name ?? null, daysLeft: Math.max(1, Math.ceil((invite.expires_at - Date.now()) / 86_400_000)) } : null,
        error: done.error,
        typedName: name,
        typedEmail: email,
      }),
      invite ? 400 : 410,
    );
  }
  const started = beginSession(c, done.person, "/");
  if (started.stage !== "full") {
    return json ? c.json({ ok: true, id: done.person.id, next: "two-step", stage: started.stage }) : c.redirect("/two-step", 303);
  }
  return json ? c.json({ ok: true, id: done.person.id }) : c.redirect("/", 303);
});

app.post("/api/setup", async (c) => {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  let token = "";
  let name = "";
  let password = "";
  try {
    const body = json ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    token = typeof body.token === "string" ? body.token : "";
    name = typeof body.name === "string" ? body.name : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return c.json({ error: "Expected the link's token, a name and a password" }, 400);
  }
  const link = ownerLinkFor(token);
  const done = await useOwnerLink(token, { name, password });
  if ("error" in done) {
    if (json) {
      return c.json({ error: done.error }, link ? 400 : 410);
    }
    return c.html(
      ownerSetupPageHtml({
        name: instanceName(),
        address: openedAddress(c),
        token,
        email: link?.email ?? null,
        resets: Boolean(link?.person),
        minutesLeft: link ? Math.max(1, Math.round((link.expires_at - Date.now()) / 60_000)) : 0,
        error: done.error,
        typedName: name,
      }),
      link ? 400 : 410,
    );
  }
  const started = beginSession(c, done.person, "/");
  if (started.stage !== "full") {
    return json ? c.json({ ok: true, id: done.person.id, next: "two-step", stage: started.stage }) : c.redirect("/two-step", 303);
  }
  return json ? c.json({ ok: true, id: done.person.id }) : c.redirect("/", 303);
});

app.use("/*", async (c, next) => {
  if (
    c.req.path === "/api/health" ||
    c.req.path === "/api/metrics" ||
    (c.req.path === "/api/sign-in" && c.req.method === "POST")
  ) {
    return next();
  }
  if (!bootAllowsRequest(bootPhase, c.req.path)) {
    return c.json({ error: "not ready", phase: bootPhase }, 503);
  }
  // A link proves its own secret (#136); the operator password never travels between instances.
  if (c.req.path.startsWith("/link/v1/")) {
    return next();
  }
  // A push monitor's keyed URL (#177): the key in the path is the credential, for a cron line
  // with no token. It writes only that monitor's result.
  if (c.req.path.startsWith("/ping/")) {
    return next();
  }
  // A share (#225) proves its own secret, below; the password does not open share reads.
  if (c.req.path.startsWith("/share/")) {
    return next();
  }
  // An embed (#227) reads with the ticket in its URL; the page, its files and the loader hold no data.
  if (c.req.path === "/embed" || c.req.path === "/embed.js" || c.req.path.startsWith("/embed/assets/")) {
    return next();
  }
  // 32a: the owner link's page and form answer before anyone can sign in.
  if (
    c.req.path.startsWith("/auth/") ||
    c.req.path.startsWith("/setup/") ||
    c.req.path.startsWith("/join/") ||
    c.req.path === "/two-step" ||
    (c.req.path.startsWith("/api/two-step/") && c.req.method === "POST") ||
    ((c.req.path === "/api/setup" || c.req.path === "/api/join") && c.req.method === "POST")
  ) {
    return next();
  }
  const header = c.req.header("authorization");
  const ingest =
    (c.req.path === "/api/ingest" ||
      c.req.path === "/v1/logs" ||
      c.req.path === "/v1/metrics" ||
      c.req.path === "/v1/marks" ||
      c.req.path === "/v1/probes" ||
      c.req.path === "/v1/checks" ||
      c.req.path === "/v1/traces" ||
      c.req.path === "/v1/profiles" ||
      c.req.path === "/v1development/profiles") &&
    c.req.method === "POST";
  // A note mark is the one write a person makes from the app (#259): a session may post one.
  const operatorMark = c.req.path === "/v1/marks" && c.req.method === "POST";
  if (isBasic(header)) {
    return c.json({ error: "Basic auth is gone in 0.9: send Authorization: Bearer with a personal or service account token from Access" }, 401);
  }
  const sender = ingest ? ingestTokenName(header) : null;
  if (sender) {
    return runAs(`token:${sender}`, () => next());
  }
  const actor = !ingest || operatorMark ? resolveActor(header, c.req.header("cookie")) : null;
  if (actor) {
    setActor(c, actor);
    // #306: the role table (30d) on every route.
    const action = actionFor(c.req.method, c.req.path);
    if (action && !roleAtLeast(actor.role, actionRole[action])) {
      const words = refusalWords(actor.role, action);
      noteAccessRefused("person", actor.person.email ?? actor.person.name, words, c.req.path);
      return c.json({ error: words, need: actionRole[action] }, 403);
    }
    return runAs(actor.person.id, () => next());
  }
  if (ingest && header?.startsWith("Bearer ")) {
    noteAccessRefused("token", "unknown", "a token that matches none", c.req.path);
  }
  // A sender holds an ingest token and nothing else. On a wrong path under the
  // ingest prefixes its token is good and its path is not, so say that.
  const sendsHere = c.req.path.startsWith("/v1/") || c.req.path.startsWith("/v1development/");
  if (sendsHere && checkBearer(header)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!ingest && checkBearer(header)) {
    return c.json({ error: "An ingest token writes in and reads nothing: send a personal or service account token" }, 401);
  }
  if (wantsPage(c)) {
    noteSeenOrigin(c);
    return signInPage(c, {});
  }
  if (ingest) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({ error: "Sign in, or send a personal or service account token" }, 401);
});

app.post("/api/sign-out", (c) => {
  endSession(readCookie(c.req.header("cookie"), sessionCookieName()));
  c.header("Set-Cookie", sessionCookieHeader("", 0, overHttps(c)));
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const actor = actorOf(c);
  if (!actor) {
    return c.json({ error: "Sign in" }, 401);
  }
  return c.json({ ...meBody(actor), initials: initials(actor.person.name) });
});

app.get("/api/instance", (c) => {
  const expiresAt = actorOf(c)?.via === "token" ? null : sessionEnd(c.req.header("cookie"));
  return c.json({
    id: instanceId(),
    name: instanceName(),
    address: openedAddress(c),
    session: expiresAt === null ? { kind: "token" } : { kind: "cookie", expires_at: expiresAt },
  });
});

app.post("/api/ingest", ingestRoute);
app.post("/v1/logs", otlpLogsRoute);
app.post("/v1/metrics", ingestMetricsRoute);
app.post("/v1/marks", ingestMarksRoute);
app.post("/v1/probes", ingestProbesRoute);
app.post("/v1/checks", ingestChecksRoute);
// GET (and HEAD) or POST, as Healthchecks' ping URL takes them.
app.get("/ping/:key/:signal?", pingRoute);
app.post("/ping/:key/:signal?", pingRoute);
app.post("/v1/traces", otlpTracesRoute);
app.post("/v1/profiles", otlpProfilesRoute);
app.post("/v1development/profiles", otlpProfilesRoute);
app.get("/api/search", searchRoute);
app.get("/api/traces/:trace_id", tracesRoute);
app.get("/api/marks", marksRoute);
app.get("/api/probes", probesRoute);
app.get("/api/profiles", profilesRoute);
app.get("/api/search/context", surroundingRoute);
app.get("/api/search/around", aroundTsRoute);
app.get("/api/search/cut", fingerprintCutRoute);
app.get("/api/search/revisions", fingerprintRevisionsRoute);
app.get("/api/fingerprints/:hex", fingerprintSeenRoute);
app.get("/api/feeds", listFeedsRoute);
app.post("/api/feeds", createFeedRoute);
app.get("/api/feeds/:id", readFeedRoute);
app.get("/api/links", listLinksRoute);
app.get("/api/links/:id", linkPageRoute);
app.put("/api/links/:id", updateLinkRoute);
app.post("/api/links/offer", offerRoute);
app.post("/api/links/invite", inviteRoute);
app.post("/api/links/preview", previewRoute);
app.post("/api/links/confirm", confirmRoute);
app.delete("/api/links/keys/:kid", revokeKeyRoute);
app.delete("/api/links/:id", removeLinkRoute);
// Instance to instance (#136): each proves a key's or a link's secret, not the operator password.
app.post("/link/v1/lookup", lookupRoute);
app.post("/link/v1/claim", claimRoute);
app.get("/link/v1/feed", linkFeedRoute);
app.post("/link/v1/remove", linkRemoveRoute);
app.post("/link/v1/ask", linkAskRoute);
app.post("/link/v1/rows", linkRowsRoute);
app.get("/api/search/follow-span", followSpanRoute);
app.get("/api/facets", facetsRoute);
app.get("/api/attr-keys", attrKeysRoute);
app.get("/api/attr-facets", attrFacetsRoute);
app.get("/api/attr-values", attrValuesRoute);
app.get("/api/numeric-keys", numericKeysRoute);
app.get("/api/metric-names", metricNamesRoute);
app.get("/api/metric-labels", metricLabelsRoute);
app.get("/api/throughput", throughputRoute);
app.get("/api/system", systemRoute);
// A version seen for the first time writes one event:update_available row, to page on (#197).
const releaseCheckDeps: CheckDeps = {
  onChecked: (releases, running) => announceNewRelease(releases, running, { write: insertEvents }),
};
// The stores are sized only when an upgrade is on offer: the panel says how big its backup is (#201).
async function versionBody(reply: VersionReply): Promise<VersionReply> {
  const upgrader = readUpgrader();
  return reply.releases.length > 0 ? { ...reply, store: await storeSize(), upgrader } : { ...reply, upgrader };
}
// Signed in, unlike /api/health: how far behind an instance is stays with its operators (#196).
app.get("/api/version", async (c) => c.json(await versionBody(versionReply())));
// Check now (#219): one check by hand, on top of the daily one.
app.post("/api/version/check", async (c) => c.json(await versionBody(await checkReleasesNow(releaseCheckDeps))));
// Upgrade from here (#220): the app writes a request into its own volume; the host's upgrade.sh runs it.
app.post("/api/version/upgrade", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
  const known = versionReply().releases.map((r) => r.version);
  const answer = requestUpgrade(body?.version, known);
  return c.json(answer.body, answer.status);
});
app.get("/api/home", getHome);
app.get("/api/home/since", homeSinceRoute);
app.put("/api/home", putHome);
app.get("/api/saved-searches", listSavedSearches);
app.post("/api/saved-searches", createSavedSearch);
app.put("/api/saved-searches/:id", updateSavedSearch);
app.delete("/api/saved-searches/:id", deleteSavedSearch);
app.get("/api/saved-searches/:id/run", runSavedSearch);
app.post("/api/saved-searches/:id/test", testSavedSearch);
app.get("/api/alert-rules", listAlertRules);
app.post("/api/alert-rules/test-call", testAlertCallRoute);
app.post("/api/alert-rules", createAlertRule);
app.put("/api/alert-rules/:id", updateMonitorRoute);
app.delete("/api/alert-rules/:id", deleteAlertRule);
// Monitors (#175); /api/alert-rules stays as their alias for 0.6.
app.get("/api/monitors", listMonitors);
// Watch this (#264): where a saved-search monitor would have opened over the last 24 h.
app.get("/api/monitors/preview", monitorPreviewRoute);
// The HTTP(S) editor's Send (#178): one request from this node, nothing stored.
app.post("/api/monitors/send", sendHttpRoute);
app.get("/api/monitors/:name", getMonitor);
app.put("/api/monitors/:name", putMonitor);
app.delete("/api/monitors/:name", deleteMonitor);
// Shares (#225): signed in to make and revoke them; /share/v1 reads with one's secret.
app.get("/api/shares", listSharesRoute);
app.post("/api/shares", createShareRoute);
app.put("/api/shares/:name", putShareRoute);
app.delete("/api/shares/:name", revokeShareRoute);
app.post("/api/shares/:name/ticket", previewTicketRoute);
app.use("/share/*", shareAuth);
app.post("/share/v1/tickets", ticketRoute);
app.get("/share/v1/*", shareReadCache);
app.get("/share/v1/series", shareSeriesRoute);
app.get("/share/v1/top", shareTopRoute);
app.get("/share/v1/names", shareNamesRoute);
app.get("/share/v1/panels/:name", sharePanelRoute);
app.get("/api/access", accessRoute);
app.get("/api/api-tokens", listApiTokens);
app.post("/api/api-tokens", createApiToken);
app.delete("/api/api-tokens/:id", deleteApiToken);
app.get("/api/people", listPeopleRoute);
app.post("/api/people/invites", createInviteRoute);
app.delete("/api/people/invites/:id", cancelInviteRoute);
app.post("/api/people/service-accounts", createServiceAccountRoute);
app.put("/api/people/:id", putPersonRoute);
app.delete("/api/people/:id", revokePersonRoute);
app.post("/api/people/:id/tokens", createServiceTokenRoute);
app.delete("/api/people/:id/tokens/:tid", revokeTokenRoute);
app.delete("/api/people/:id/two-step", resetTwoStepRoute);
app.post("/api/me/two-step/backup-codes", newBackupCodesRoute);
app.get("/api/me/tokens", myTokensRoute);
app.post("/api/me/tokens", createMyTokenRoute);
app.delete("/api/me/tokens/:id", revokeTokenRoute);
app.get("/api/sign-in-settings", (c) => c.json({ ...signInSettings(), redirect_uri: redirectUri(c), two_step_for: twoStepFor() }));

app.put("/api/sign-in-settings", async (c) => {
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
});

app.get("/api/settings", getSettings);
app.put("/api/settings", putSettings);
app.get("/api/fields", getFields);
app.put("/api/fields", putFields);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/share/*", (c) => c.json({ error: "Not found" }, 404));
app.get("/embed", embedPageRoute);
app.get("/embed.js", embedJsRoute);
app.get("/embed/assets/*", embedAssetRoute);
// The ingest paths are an API too: a typo or a wrong method must not get the UI page.
app.all("/v1/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/v1development/*", (c) => c.json({ error: "Not found" }, 404));
// Any other method or shape under /ping is the same 404 an unknown key gets.
app.all("/ping/*", () => new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));

// #109: the bare address opens on Home, at that saved search's own URL; any link keeps its own.
app.get("/", (c, next) => {
  const home = new URL(c.req.url).search === "" ? homeSaved() : null;
  return home ? c.redirect(`/${savedSearchUrl(home)}`, 302) : next();
});

app.use("/*", serveStatic({ root: "./src/ui/dist" }));
app.get("*", async (c) => {
  const file = Bun.file("./src/ui/dist/index.html");
  if (await file.exists()) {
    return c.html(await file.text());
  }
  return c.text("UI not built. Run bun run build:ui", 500);
});

export default {
  port: Number(process.env.PORT ?? 8080),
  hostname: process.env.HOST ?? "0.0.0.0",
  /** Default 10s kills long scans (empty 7d, host facets); event pages widen lookback first. */
  idleTimeout: 120,
  // Bun hands the running server to fetch and to nothing else here; stop() needs it.
  fetch(request: Request, bun?: Server<unknown>) {
    server ??= bun;
    return app.fetch(request, bun);
  },
};

// `docker compose stop`, an upgrade and a host shutdown send SIGTERM, and in the
// image this is process 1, which ignores a signal it does not handle.
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

void startBoot();

/** Finish the requests in flight and the syslog queue, then exit 0. */
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  // Refuses new connections and resolves once every request in flight has its reply.
  await Promise.all([server?.stop(), stopSyslog(), stopGrpc()]);
  process.exit(0);
}

async function startBoot(): Promise<void> {
  try {
    bootPhase = "schema";
    await migrateStore();
    // Not fatal: the first insert loads it again. Until then a feed says it has settled nothing.
    await loadArrivalSeq().catch((err) => console.error("arrival sequence not loaded yet", err));
    bootPhase = "repair";
    getDb();
    // #308: the .env ingest token becomes a token in Access once; it is never read from .env again.
    if (importEnvIngestToken(process.env.TOPOSCOPE_INGEST_TOKEN)) {
      console.warn("Imported TOPOSCOPE_INGEST_TOKEN from .env as the ingest token \"env (imported)\" in Access; .env is not read for it again.");
    }
    setHereName(instanceName());
    await syncFieldRoleSkip(storedSkipKeys());
    await applyRetentionDays(getRetentionDays(), effectiveMetricsRetentionDays());
    startAlertCron();
    // HTTP(S) monitors keep their own pace, 30s … 1h each, apart from the 60s alert pass.
    startHttpMonitors();
    startLinkPuller();
    // Once a minute, each share that was read writes one use row (#226).
    startShareUse(insertEvents);
    startAccessUse(insertEvents);
    // Once a day, a few minutes after boot: is a newer release out (#196)? Off with TOPOSCOPE_UPDATE_CHECK=off.
    startReleaseCheck(releaseCheckDeps);
    // A stubbed listener in tests returns nothing.
    stopSyslog = (await startSyslogUdp()) ?? stopSyslog;
    // OTLP over gRPC: each call goes through the same routes, and the same checks, as HTTP.
    stopGrpc = (await startOtlpGrpc((request) => app.fetch(request)))?.stop ?? stopGrpc;
    bootPhase = "ready";
  } catch (err) {
    console.error("boot failed", err);
    process.exit(1);
  }
}
