import type { Server } from "bun";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { startAlertCron } from "./alerts/cron";
import { startHttpMonitors } from "./alerts/http-cron";
import {
  checkBasic,
  passwordMatches,
  readCookie,
  sessionCookieHeader,
  sessionCookieName,
  basicPassword,
  checkBearer,
  unauthorizedHeaders,
} from "./auth";
import { getDb, getHealth } from "./control";
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
import { savedSearchUrl } from "./ui/search-url";
import { createSession, endSession, sessionExpiry, sessionMs } from "./control/sessions";
import { safeNext, signInPageHtml } from "./sign-in-page";
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
import { startReleaseCheck, versionReply } from "./control/release-check";
import { announceNewRelease } from "./control/update-event";
import { storeSize } from "./control/store-size";
import { bootAllowsRequest, type BootPhase } from "./shared/boot";

requirePackagedSecrets();
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

function signInPage(c: Context, opts: { wrong?: boolean; next?: string; status?: 200 | 401 }): Response {
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
    }),
    opts.status ?? 401,
  );
}

// #102: a browser that does not show the Basic prompt signs in on a page instead.
app.post("/api/sign-in", async (c) => {
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  let password = "";
  let nextPath = "/";
  try {
    const body = json ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    password = typeof body.password === "string" ? body.password : "";
    nextPath = safeNext(typeof body.next === "string" ? body.next : "/");
  } catch {
    return c.json({ error: "Expected a password" }, 400);
  }
  if (!basicPassword() || !passwordMatches(password)) {
    // A short pause, so guessing is slow.
    await Bun.sleep(750);
    return json ? c.json({ error: "Wrong password" }, 401) : signInPage(c, { wrong: true, next: nextPath });
  }
  const session = createSession(basicPassword()!);
  c.header("Set-Cookie", sessionCookieHeader(session.value, Math.floor(sessionMs / 1000), overHttps(c)));
  return json ? c.json({ ok: true, expires_at: session.expiresAt }) : c.redirect(nextPath, 303);
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
  const cookie = ingest ? undefined : readCookie(c.req.header("cookie"), sessionCookieName());
  const allowed = ingest
    ? checkBearer(header) || checkBasic(header)
    : checkBasic(header) || sessionExpiry(cookie, basicPassword()) !== null;
  if (!allowed) {
    // A sender holds an ingest token and nothing else. On a wrong path under the
    // ingest prefixes its token is good and its path is not, so say that.
    const sendsHere =
      c.req.path.startsWith("/v1/") || c.req.path.startsWith("/v1development/");
    if (sendsHere && checkBearer(header)) {
      return c.json({ error: "Not found" }, 404);
    }
    if (wantsPage(c)) {
      return signInPage(c, {});
    }
    // A request with a cookie came from a signed-in browser: never the Basic prompt on top.
    if (cookie) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders());
  }
  return next();
});

app.post("/api/sign-out", (c) => {
  endSession(readCookie(c.req.header("cookie"), sessionCookieName()));
  c.header("Set-Cookie", sessionCookieHeader("", 0, overHttps(c)));
  return c.json({ ok: true });
});

app.get("/api/instance", (c) => {
  const cookie = readCookie(c.req.header("cookie"), sessionCookieName());
  const expiresAt = checkBasic(c.req.header("authorization")) ? null : sessionExpiry(cookie, basicPassword());
  return c.json({
    id: instanceId(),
    name: instanceName(),
    address: openedAddress(c),
    session: expiresAt === null ? { kind: "basic" } : { kind: "cookie", expires_at: expiresAt },
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
app.get("/api/feeds", listFeedsRoute);
app.post("/api/feeds", createFeedRoute);
app.get("/api/feeds/:id", readFeedRoute);
app.get("/api/links", listLinksRoute);
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
// Signed in, unlike /api/health: how far behind an instance is stays with its operators (#196).
app.get("/api/version", async (c) => {
  const reply = versionReply();
  // The stores are sized only when an upgrade is on offer: the panel says how big its backup is (#201).
  return c.json(reply.releases.length > 0 ? { ...reply, store: await storeSize() } : reply);
});
app.get("/api/home", getHome);
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
// The HTTP(S) editor's Send (#178): one request from this node, nothing stored.
app.post("/api/monitors/send", sendHttpRoute);
app.get("/api/monitors/:name", getMonitor);
app.put("/api/monitors/:name", putMonitor);
app.delete("/api/monitors/:name", deleteMonitor);
app.get("/api/api-tokens", listApiTokens);
app.post("/api/api-tokens", createApiToken);
app.delete("/api/api-tokens/:id", deleteApiToken);
app.get("/api/settings", getSettings);
app.put("/api/settings", putSettings);
app.get("/api/fields", getFields);
app.put("/api/fields", putFields);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
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
    setHereName(instanceName());
    await syncFieldRoleSkip(storedSkipKeys());
    await applyRetentionDays(getRetentionDays(), effectiveMetricsRetentionDays());
    startAlertCron();
    // HTTP(S) monitors keep their own pace, 30s … 1h each, apart from the 60s alert pass.
    startHttpMonitors();
    startLinkPuller();
    // Once a day, a few minutes after boot: is a newer release out (#196)? Off with TOPOSCOPE_UPDATE_CHECK=off.
    // A version seen for the first time writes one event:update_available row, to page on (#197).
    startReleaseCheck({ onChecked: (releases, running) => announceNewRelease(releases, running, { write: insertEvents }) });
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
