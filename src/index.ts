import type { Server } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { startAlertCron } from "./alerts/cron";
import {
  checkBasic,
  checkBearer,
  unauthorizedHeaders,
} from "./auth";
import { getDb, getHealth } from "./control";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  updateAlertRule,
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
import { getRetentionDays, getSettings, putSettings } from "./control/settings";
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
} from "./control/tokens";
import { ingestRoute } from "./ingest";
import { ingestMetricsRoute } from "./ingest/metrics";
import { ingestMarksRoute } from "./ingest/marks";
import { ingestProbesRoute } from "./ingest/probes";
import { otlpLogsRoute } from "./ingest/otlp-route";
import { otlpTracesRoute } from "./ingest/otlp-traces-route";
import { otlpProfilesRoute } from "./ingest/otlp-profiles-route";
import { startSyslogUdp } from "./ingest/syslog";
import { renderMetrics } from "./metrics";
import { attrFacetsRoute, attrKeysRoute, attrValuesRoute, aroundTsRoute, facetsRoute, metricNamesRoute, numericKeysRoute, searchRoute, surroundingRoute } from "./query";
import { fingerprintCutRoute } from "./query/fingerprint-cut";
import { tracesRoute } from "./query/traces";
import { marksRoute } from "./query/marks";
import { probesRoute } from "./query/probes";
import { profilesRoute } from "./query/profiles";
import { systemRoute } from "./query/system";
import { throughputRoute } from "./query/throughput";
import { applyRetentionDays, migrateStore, syncFieldRoleSkip } from "./shared/migrate";
import { requirePackagedSecrets } from "./shared/secrets";
import { bootAllowsRequest, type BootPhase } from "./shared/boot";

requirePackagedSecrets();

let bootPhase: BootPhase = "starting";
/** Set by SIGTERM or SIGINT: the process is finishing what it has and takes nothing new. */
let stopping = false;
let server: Server<unknown> | undefined;
let stopSyslog: () => Promise<void> = async () => {};

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

app.use("/*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path === "/api/metrics") {
    return next();
  }
  if (!bootAllowsRequest(bootPhase, c.req.path)) {
    return c.json({ error: "not ready", phase: bootPhase }, 503);
  }
  const header = c.req.header("authorization");
  const ingest =
    (c.req.path === "/api/ingest" ||
      c.req.path === "/v1/logs" ||
      c.req.path === "/v1/metrics" ||
      c.req.path === "/v1/marks" ||
      c.req.path === "/v1/probes" ||
      c.req.path === "/v1/traces" ||
      c.req.path === "/v1/profiles" ||
      c.req.path === "/v1development/profiles") &&
    c.req.method === "POST";
  const allowed = ingest
    ? checkBearer(header) || checkBasic(header)
    : checkBasic(header);
  if (!allowed) {
    return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders());
  }
  return next();
});

app.post("/api/ingest", ingestRoute);
app.post("/v1/logs", otlpLogsRoute);
app.post("/v1/metrics", ingestMetricsRoute);
app.post("/v1/marks", ingestMarksRoute);
app.post("/v1/probes", ingestProbesRoute);
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
app.get("/api/facets", facetsRoute);
app.get("/api/attr-keys", attrKeysRoute);
app.get("/api/attr-facets", attrFacetsRoute);
app.get("/api/attr-values", attrValuesRoute);
app.get("/api/numeric-keys", numericKeysRoute);
app.get("/api/metric-names", metricNamesRoute);
app.get("/api/throughput", throughputRoute);
app.get("/api/system", systemRoute);
app.get("/api/saved-searches", listSavedSearches);
app.post("/api/saved-searches", createSavedSearch);
app.put("/api/saved-searches/:id", updateSavedSearch);
app.delete("/api/saved-searches/:id", deleteSavedSearch);
app.get("/api/saved-searches/:id/run", runSavedSearch);
app.post("/api/saved-searches/:id/test", testSavedSearch);
app.get("/api/alert-rules", listAlertRules);
app.post("/api/alert-rules", createAlertRule);
app.put("/api/alert-rules/:id", updateAlertRule);
app.delete("/api/alert-rules/:id", deleteAlertRule);
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
  await Promise.all([server?.stop(), stopSyslog()]);
  process.exit(0);
}

async function startBoot(): Promise<void> {
  try {
    bootPhase = "schema";
    await migrateStore();
    bootPhase = "repair";
    getDb();
    await syncFieldRoleSkip(storedSkipKeys());
    await applyRetentionDays(getRetentionDays());
    startAlertCron();
    // A stubbed listener in tests returns nothing.
    stopSyslog = (await startSyslogUdp()) ?? stopSyslog;
    bootPhase = "ready";
  } catch (err) {
    console.error("boot failed", err);
    process.exit(1);
  }
}
