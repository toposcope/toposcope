import { encodeOtlpProtobuf } from "../src/ingest/otlp-protobuf";
import { toOtlpProfilesJson } from "../src/ingest/otlp-profiles";
import { encodeOtlpProfilesProtobuf } from "../src/ingest/otlp-profiles-protobuf";
import { toOtlpTracesJson } from "../src/ingest/otlp-traces";
import { encodeOtlpTracesProtobuf } from "../src/ingest/otlp-traces-protobuf";
import { formatSyslog3164 } from "../src/ingest/syslog-parse";
import { evaluateAlerts } from "../src/alerts/cron";
import { runLiveLoad } from "./load-live";
import { parseLiveArgs } from "./load-rates";
import { envValue } from "../src/shared/env";
import { fakeFramedFingerprint } from "../src/shared/fake-event";
import type { Span } from "../src/shared/span";

const APP_URL = envValue("TOPOSCOPE_URL") ?? "http://127.0.0.1:8080";
const INGEST_TOKEN = envValue("TOPOSCOPE_INGEST_TOKEN") ?? "toposcope-ingest";
const PASSWORD = envValue("TOPOSCOPE_PASSWORD") ?? "toposcope";

function basicAuth(): string {
  return `Basic ${btoa(`toposcope:${PASSWORD}`)}`;
}

async function expectOtlpGzipCap(path: string): Promise<void> {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "content-encoding": "gzip",
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: Bun.gzipSync(Buffer.alloc(8 * 1024 * 1024)),
  });
  if (res.status !== 413) {
    throw new Error(
      `${path} gzip cap expected 413, got ${res.status} ${await res.text()}`,
    );
  }
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      const json = (await res.json()) as { ok?: boolean; phase?: string };
      if (res.ok && json.ok) {
        if (json.phase && json.phase !== "ready") {
          throw new Error(`health 200 with phase ${json.phase}`);
        }
        return;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  throw new Error(`health check did not pass at ${APP_URL}`);
}

async function main(): Promise<void> {
  process.env.SQLITE_PATH ??= "./data/toposcope.sqlite";
  process.env.CLICKHOUSE_USER ??= "default";
  process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
  await waitForHealth();

  const marker = `e2e${Date.now()}`;
  const ingestRes = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: `${JSON.stringify({
      service: "e2e",
      level: "error",
      message: marker,
      attrs: { path: "/e2e", status: 500, user_id: "e2e", duration_ms: 42 },
    })}\n`,
  });
  if (!ingestRes.ok) {
    throw new Error(`ingest failed: ${ingestRes.status} ${await ingestRes.text()}`);
  }
  const ingested = (await ingestRes.json()) as { ingested: number };
  if (ingested.ingested !== 1) {
    throw new Error(`expected ingested=1, got ${ingested.ingested}`);
  }

  const extraMarker = `e2ex${Date.now()}`;
  const extraIngestRes = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: `${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} connection timeout`,
      attrs: { duration_ms: 100 },
    })}\n${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} connection timeout`,
      attrs: { duration_ms: "n/a" },
    })}\n${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} timeouts`,
      attrs: { duration_ms: 9000 },
    })}\n${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} context deadline exceeded`,
    })}\n${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} deadline was exceeded`,
    })}\n${JSON.stringify({
      service: "e2e",
      level: "error",
      message: `${extraMarker} hop-7 ok`,
    })}\n`,
  });
  if (!extraIngestRes.ok) {
    throw new Error(
      `extra ingest failed: ${extraIngestRes.status} ${await extraIngestRes.text()}`,
    );
  }

  const throughputRes = await fetch(`${APP_URL}/api/throughput`, {
    headers: { authorization: basicAuth() },
  });
  if (!throughputRes.ok) {
    throw new Error(`throughput failed: ${throughputRes.status} ${await throughputRes.text()}`);
  }
  const throughput = (await throughputRes.json()) as {
    per_second: number;
    histogram: Array<{ t: string; n: number }>;
  };
  if (!Array.isArray(throughput.histogram) || throughput.histogram.length < 1) {
    throw new Error("throughput missing histogram");
  }
  if (typeof throughput.per_second !== "number") {
    throw new Error("throughput missing per_second");
  }

  const systemRes = await fetch(`${APP_URL}/api/system`, {
    headers: { authorization: basicAuth() },
  });
  if (!systemRes.ok) {
    throw new Error(`system failed: ${systemRes.status} ${await systemRes.text()}`);
  }
  const system = (await systemRes.json()) as {
    app?: { mem_used?: number };
    clickhouse?: { mem_used?: number; disk_used?: number } | null;
  };
  if (typeof system.app?.mem_used !== "number" || system.app.mem_used <= 0) {
    throw new Error("system missing app.mem_used");
  }
  if (
    system.clickhouse !== null &&
    (typeof system.clickhouse?.mem_used !== "number" ||
      typeof system.clickhouse.disk_used !== "number")
  ) {
    throw new Error("system clickhouse missing mem_used/disk_used");
  }

  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60 * 1000).toISOString();
  const params = new URLSearchParams({
    from,
    to,
    q: `level:error service:e2e ${marker}`,
  });
  const searchRes = await fetch(`${APP_URL}/api/search?${params.toString()}`, {
    headers: { authorization: basicAuth() },
  });
  if (!searchRes.ok) {
    throw new Error(`search failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const search = (await searchRes.json()) as {
    events: Array<{ message: string }>;
    histogram: Array<{ n: number; by_level: Record<string, number> }>;
    total: number;
    nextCursor: string | null;
  };
  if (!search.events.some((event) => event.message === marker)) {
    throw new Error("search did not return the ingested event");
  }
  if (search.histogram.length < 1) {
    throw new Error("expected histogram length >= 1");
  }
  if (search.total < 1) {
    throw new Error("expected total >= 1");
  }
  if (!search.histogram.some((bucket) => (bucket.by_level.error ?? 0) > 0)) {
    throw new Error("expected an error bucket in the histogram");
  }

  const booleanRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `level:error OR level:fatal service:e2e "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!booleanRes.ok) {
    throw new Error(
      `boolean search failed: ${booleanRes.status} ${await booleanRes.text()}`,
    );
  }
  const booleanSearch = (await booleanRes.json()) as {
    events: Array<{ message: string }>;
  };
  if (!booleanSearch.events.some((event) => event.message === marker)) {
    throw new Error("quoted OR search did not return the ingested event");
  }

  const globRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e status:5* "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!globRes.ok) {
    throw new Error(`glob search failed: ${globRes.status} ${await globRes.text()}`);
  }
  const globSearch = (await globRes.json()) as { events: Array<{ message: string }> };
  if (!globSearch.events.some((event) => event.message === marker)) {
    throw new Error("status:5* search did not return the ingested event");
  }

  const cmpHitRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e duration_ms:>40 "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cmpHitRes.ok) {
    throw new Error(
      `duration_ms:>40 search failed: ${cmpHitRes.status} ${await cmpHitRes.text()}`,
    );
  }
  const cmpHit = (await cmpHitRes.json()) as { events: Array<{ message: string }> };
  if (!cmpHit.events.some((event) => event.message === marker)) {
    throw new Error("duration_ms:>40 search did not return the ingested event");
  }

  const cmpEqRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e duration_ms:42 "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cmpEqRes.ok) {
    throw new Error(
      `duration_ms:42 search failed: ${cmpEqRes.status} ${await cmpEqRes.text()}`,
    );
  }
  const cmpEq = (await cmpEqRes.json()) as { events: Array<{ message: string }> };
  if (!cmpEq.events.some((event) => event.message === marker)) {
    throw new Error("duration_ms:42 search did not return the ingested event");
  }

  const cmpMissRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e duration_ms:>100 "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cmpMissRes.ok) {
    throw new Error(
      `duration_ms:>100 search failed: ${cmpMissRes.status} ${await cmpMissRes.text()}`,
    );
  }
  const cmpMiss = (await cmpMissRes.json()) as { events: Array<{ message: string }> };
  if (cmpMiss.events.some((event) => event.message === marker)) {
    throw new Error("duration_ms:>100 must not match duration_ms 42");
  }

  const cmpQuotedRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e duration_ms:">100" "${marker}"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cmpQuotedRes.ok) {
    throw new Error(
      `quoted duration_ms search failed: ${cmpQuotedRes.status} ${await cmpQuotedRes.text()}`,
    );
  }
  const cmpQuoted = (await cmpQuotedRes.json()) as {
    events: Array<{ message: string }>;
  };
  if (cmpQuoted.events.some((event) => event.message === marker)) {
    throw new Error('duration_ms:">100" must stay string equality');
  }

  const cmpAggRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `service:e2e duration_ms:>40 "${marker}"`,
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cmpAggRes.ok) {
    throw new Error(
      `p99 on comparison q failed: ${cmpAggRes.status} ${await cmpAggRes.text()}`,
    );
  }
  const cmpAgg = (await cmpAggRes.json()) as {
    agg?: { source: string; stat: number | null };
  };
  if (cmpAgg.agg?.source !== "numeric") {
    throw new Error(
      `p99 on duration_ms:>40 expected numeric, got ${cmpAgg.agg?.source}`,
    );
  }
  if (cmpAgg.agg.stat !== 42) {
    throw new Error(
      `p99 on duration_ms:>40 "${marker}" expected 42, got ${cmpAgg.agg.stat}`,
    );
  }

  const badRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: "level:error OR",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (badRes.status !== 400) {
    throw new Error(`expected 400 for a broken query, got ${badRes.status}`);
  }

  const p99Res = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: "service:e2e",
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!p99Res.ok) {
    throw new Error(`p99 search failed: ${p99Res.status} ${await p99Res.text()}`);
  }
  const p99Search = (await p99Res.json()) as {
    agg?: { source: string; stat: number | null; buckets: Array<{ v: number }> };
  };
  if (p99Search.agg?.source !== "numeric") {
    throw new Error(`expected numeric p99, got ${p99Search.agg?.source}`);
  }
  if (typeof p99Search.agg.stat !== "number") {
    throw new Error("expected p99 window stat");
  }

  const noEventsRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: "service:e2e",
      events: "0",
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!noEventsRes.ok) {
    throw new Error(
      `events=0 search failed: ${noEventsRes.status} ${await noEventsRes.text()}`,
    );
  }
  const noEvents = (await noEventsRes.json()) as {
    events: unknown[];
    histogram: unknown[];
    agg?: { source: string };
  };
  if (noEvents.events.length !== 0) {
    throw new Error("events=0 must skip the event page");
  }
  if (noEvents.histogram.length === 0) {
    throw new Error("events=0 must still return the histogram");
  }
  if (noEvents.agg?.source !== "numeric") {
    throw new Error(`events=0 p99 expected numeric, got ${noEvents.agg?.source}`);
  }

  const numericKeysRes = await fetch(
    `${APP_URL}/api/numeric-keys?${new URLSearchParams({
      from,
      to,
      q: "service:e2e",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!numericKeysRes.ok) {
    throw new Error(
      `numeric-keys failed: ${numericKeysRes.status} ${await numericKeysRes.text()}`,
    );
  }
  const numericKeys = (await numericKeysRes.json()) as {
    keys: Array<{ k: string }>;
  };
  if (!numericKeys.keys.some((item) => item.k === "duration_ms")) {
    throw new Error(
      `expected duration_ms in numeric-keys, got ${numericKeys.keys.map((item) => item.k).join(",")}`,
    );
  }

  const refusedKeysRes = await fetch(
    `${APP_URL}/api/numeric-keys?${new URLSearchParams({
      from,
      to,
      q: marker,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!refusedKeysRes.ok) {
    throw new Error(
      `numeric-keys (message q) failed: ${refusedKeysRes.status} ${await refusedKeysRes.text()}`,
    );
  }
  const refusedKeys = (await refusedKeysRes.json()) as {
    keys: Array<{ k: string }>;
  };
  if (refusedKeys.keys.length !== 0) {
    throw new Error("message-term q must not list numeric-keys");
  }

  const filteredRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: marker,
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!filteredRes.ok) {
    throw new Error(
      `message-term p99 search failed: ${filteredRes.status} ${await filteredRes.text()}`,
    );
  }
  const filteredSearch = (await filteredRes.json()) as {
    agg?: { source: string; stat: number | null };
  };
  if (filteredSearch.agg?.source !== "numeric") {
    throw new Error(
      `message-term p99 expected numeric, got ${filteredSearch.agg?.source}`,
    );
  }
  if (typeof filteredSearch.agg.stat !== "number" || filteredSearch.agg.stat !== 42) {
    throw new Error(
      `message-term p99 expected 42, got ${filteredSearch.agg.stat}`,
    );
  }

  const timeoutP99Res = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `${extraMarker} timeout`,
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!timeoutP99Res.ok) {
    throw new Error(
      `timeout p99 failed: ${timeoutP99Res.status} ${await timeoutP99Res.text()}`,
    );
  }
  const timeoutP99 = (await timeoutP99Res.json()) as {
    agg?: { source: string; stat: number | null };
  };
  if (timeoutP99.agg?.source !== "numeric" || timeoutP99.agg.stat !== 100) {
    throw new Error(
      `timeout p99 expected 100 (junk/timeouts ignored), got ${timeoutP99.agg?.source} ${timeoutP99.agg?.stat}`,
    );
  }

  const timeoutsP99Res = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `${extraMarker} timeouts`,
      agg: "p99:duration_ms",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!timeoutsP99Res.ok) {
    throw new Error(
      `timeouts p99 failed: ${timeoutsP99Res.status} ${await timeoutsP99Res.text()}`,
    );
  }
  const timeoutsP99 = (await timeoutsP99Res.json()) as {
    agg?: { source: string; stat: number | null };
  };
  if (timeoutsP99.agg?.source !== "numeric" || timeoutsP99.agg.stat !== 9000) {
    throw new Error(
      `timeouts p99 expected 9000, got ${timeoutsP99.agg?.source} ${timeoutsP99.agg?.stat}`,
    );
  }

  const sinceP99Res = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      since: from,
      q: `${extraMarker} timeout`,
      agg: "p99:duration_ms",
      events: "0",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!sinceP99Res.ok) {
    throw new Error(
      `since p99 failed: ${sinceP99Res.status} ${await sinceP99Res.text()}`,
    );
  }
  const sinceP99 = (await sinceP99Res.json()) as { agg?: unknown };
  if (sinceP99.agg) {
    throw new Error("logs-scan p99 must omit agg on since=");
  }

  const phraseRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `${extraMarker} "deadline exceeded"`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!phraseRes.ok) {
    throw new Error(
      `phrase search failed: ${phraseRes.status} ${await phraseRes.text()}`,
    );
  }
  const phraseHits = (await phraseRes.json()) as {
    events: Array<{ message: string }>;
  };
  if (
    !phraseHits.events.some((event) =>
      event.message.includes("context deadline exceeded"),
    )
  ) {
    throw new Error('"deadline exceeded" must match consecutive tokens');
  }
  if (
    phraseHits.events.some((event) => event.message.includes("deadline was exceeded"))
  ) {
    throw new Error('"deadline exceeded" must not match a gapped pair');
  }

  const hyphenRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `${extraMarker} hop-7`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!hyphenRes.ok) {
    throw new Error(
      `hyphen search failed: ${hyphenRes.status} ${await hyphenRes.text()}`,
    );
  }
  const hyphenHits = (await hyphenRes.json()) as {
    events: Array<{ message: string }>;
  };
  if (!hyphenHits.events.some((event) => event.message.includes("hop-7"))) {
    throw new Error("hyphenated hop-7 must be searchable");
  }

  const badAgg = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      agg: "nope",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (badAgg.status !== 400) {
    throw new Error(`expected 400 for invalid agg, got ${badAgg.status}`);
  }

  const metricTs = new Date().toISOString();
  const metricRes = await fetch(`${APP_URL}/v1/metrics`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify([
      { name: "cpu_seconds", value: 0.42, ts: metricTs },
      {
        name: "cpu_seconds",
        value: 0.84,
        ts: metricTs,
        labels: { service: "api" },
      },
    ]),
  });
  if (!metricRes.ok) {
    throw new Error(`metrics ingest failed: ${metricRes.status} ${await metricRes.text()}`);
  }
  const metricIngested = (await metricRes.json()) as { ingested: number };
  if (metricIngested.ingested !== 2) {
    throw new Error(`expected 2 metric points, got ${metricIngested.ingested}`);
  }

  const unauthorizedMetrics = await fetch(`${APP_URL}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "cpu_seconds", value: 1 }),
  });
  if (unauthorizedMetrics.status !== 401) {
    throw new Error(`expected 401 for /v1/metrics without auth, got ${unauthorizedMetrics.status}`);
  }

  const markTs = new Date().toISOString();
  const markRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "deploy",
      title: "v0.9",
      service: "billing",
      ts: markTs,
      attrs: { version: "v0.9", sha: "e2e" },
    }),
  });
  if (!markRes.ok) {
    throw new Error(`marks ingest failed: ${markRes.status} ${await markRes.text()}`);
  }
  const markIngested = (await markRes.json()) as { ingested: number };
  if (markIngested.ingested !== 1) {
    throw new Error(`expected 1 change mark, got ${markIngested.ingested}`);
  }
  const marksGet = await fetch(
    `${APP_URL}/api/marks?${new URLSearchParams({ range: "15m" }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!marksGet.ok) {
    throw new Error(`marks list failed: ${marksGet.status} ${await marksGet.text()}`);
  }
  const marksBody = (await marksGet.json()) as {
    marks: Array<{ title: string; kind: string; id?: string; end_ts?: string | null }>;
    before?: unknown;
    after?: unknown;
  };
  if (!("before" in marksBody) || !("after" in marksBody)) {
    throw new Error("GET /api/marks missing before/after neighbors");
  }
  const postedMark = marksBody.marks.find(
    (mark) => mark.title === "v0.9" && mark.kind === "deploy",
  );
  if (!postedMark) {
    throw new Error("posted change mark missing from GET /api/marks");
  }
  if (typeof postedMark.id !== "string" || postedMark.id.length === 0) {
    throw new Error("posted change mark missing id");
  }
  const cutMissing = await fetch(`${APP_URL}/api/search/cut`, {
    headers: { authorization: basicAuth() },
  });
  if (cutMissing.status !== 400) {
    throw new Error(
      `GET /api/search/cut without mark expected 400, got ${cutMissing.status}`,
    );
  }
  const cutGet = await fetch(
    `${APP_URL}/api/search/cut?${new URLSearchParams({
      mark: postedMark.id,
      range: "15m",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!cutGet.ok) {
    throw new Error(`cut search failed: ${cutGet.status} ${await cutGet.text()}`);
  }
  const cutBody = (await cutGet.json()) as { sets?: unknown; title?: string };
  if (!Array.isArray(cutBody.sets) || typeof cutBody.title !== "string") {
    throw new Error("GET /api/search/cut missing sets or title");
  }
  const incidentEnd = new Date(Date.parse(markTs) + 60_000).toISOString();
  const incidentRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-inc",
      id: "e2e-inc-1",
      ts: markTs,
      end_ts: incidentEnd,
    }),
  });
  if (!incidentRes.ok) {
    throw new Error(
      `incident mark ingest failed: ${incidentRes.status} ${await incidentRes.text()}`,
    );
  }
  const incidentGet = await fetch(
    `${APP_URL}/api/marks?${new URLSearchParams({ range: "15m" }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!incidentGet.ok) {
    throw new Error(
      `incident marks list failed: ${incidentGet.status} ${await incidentGet.text()}`,
    );
  }
  const incidentBody = (await incidentGet.json()) as {
    marks: Array<{ id: string; end_ts: string | null; title: string }>;
  };
  const incident = incidentBody.marks.find((mark) => mark.id === "e2e-inc-1");
  if (!incident || incident.end_ts == null) {
    throw new Error("incident mark missing id/end_ts round-trip");
  }
  const incidentRetry = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-inc",
      id: "e2e-inc-1",
      ts: markTs,
      end_ts: incidentEnd,
    }),
  });
  if (!incidentRetry.ok) {
    throw new Error(
      `incident mark retry failed: ${incidentRetry.status} ${await incidentRetry.text()}`,
    );
  }
  const incidentRetryBody = (await incidentRetry.json()) as { ingested: number };
  if (incidentRetryBody.ingested !== 0) {
    throw new Error(
      `expected 0 ingested on duplicate mark id, got ${incidentRetryBody.ingested}`,
    );
  }
  const incidentDupGet = await fetch(
    `${APP_URL}/api/marks?${new URLSearchParams({ range: "15m" }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!incidentDupGet.ok) {
    throw new Error(
      `duplicate marks list failed: ${incidentDupGet.status} ${await incidentDupGet.text()}`,
    );
  }
  const incidentDupBody = (await incidentDupGet.json()) as {
    marks: Array<{ id: string }>;
  };
  const incidentDupCount = incidentDupBody.marks.filter(
    (mark) => mark.id === "e2e-inc-1",
  ).length;
  if (incidentDupCount !== 1) {
    throw new Error(`expected 1 mark for e2e-inc-1, got ${incidentDupCount}`);
  }
  const unauthorizedMarks = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "deploy", title: "v0.9" }),
  });
  if (unauthorizedMarks.status !== 401) {
    throw new Error(`expected 401 for /v1/marks without auth, got ${unauthorizedMarks.status}`);
  }

  const badMetric = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      events: "0",
      metric: "foo-bar",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (badMetric.status !== 400) {
    throw new Error(`expected 400 for invalid metric, got ${badMetric.status}`);
  }

  let metricSearch: {
    agg?: { source: string; expr: string; stat: number | null; buckets: Array<{ v: number }> };
  } | null = null;
  const metricDeadline = Date.now() + 10_000;
  while (Date.now() < metricDeadline) {
    const metricSearchRes = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({
        from,
        to,
        events: "0",
        metric: "cpu_seconds",
      }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!metricSearchRes.ok) {
      throw new Error(
        `metric search failed: ${metricSearchRes.status} ${await metricSearchRes.text()}`,
      );
    }
    metricSearch = (await metricSearchRes.json()) as {
      agg?: { source: string; expr: string; stat: number | null; buckets: Array<{ v: number }> };
    };
    if (metricSearch.agg?.source === "metric" && typeof metricSearch.agg.stat === "number") {
      break;
    }
    await Bun.sleep(200);
  }
  if (metricSearch?.agg?.source !== "metric") {
    throw new Error(`expected metric overlay, got ${metricSearch?.agg?.source}`);
  }
  if (typeof metricSearch.agg.stat !== "number") {
    throw new Error("expected unlabeled cpu_seconds window stat");
  }

  const metricWithQRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: "timeout",
      events: "0",
      metric: "cpu_seconds",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!metricWithQRes.ok) {
    throw new Error(
      `metric + log q failed: ${metricWithQRes.status} ${await metricWithQRes.text()}`,
    );
  }
  const metricWithQ = (await metricWithQRes.json()) as {
    agg?: { source: string; stat: number | null };
  };
  if (metricWithQ.agg?.source !== "metric") {
    throw new Error(`log q must not refuse a metric series, got ${metricWithQ.agg?.source}`);
  }
  if (typeof metricWithQ.agg.stat !== "number") {
    throw new Error("log q must not zero a metric series");
  }

  const labeledMetricRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      events: "0",
      metric: "cpu_seconds",
      ml: "service:api",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!labeledMetricRes.ok) {
    throw new Error(
      `labeled metric search failed: ${labeledMetricRes.status} ${await labeledMetricRes.text()}`,
    );
  }
  const labeledMetric = (await labeledMetricRes.json()) as {
    agg?: { source: string; expr: string; stat: number | null };
  };
  if (labeledMetric.agg?.source !== "metric") {
    throw new Error(`expected labeled metric overlay, got ${labeledMetric.agg?.source}`);
  }
  if (labeledMetric.agg.expr !== "cpu_seconds{service=api}") {
    throw new Error(`expected labeled expr, got ${labeledMetric.agg.expr}`);
  }
  if (typeof labeledMetric.agg.stat !== "number") {
    throw new Error("expected labeled cpu_seconds window stat");
  }

  const metricNamesRes = await fetch(
    `${APP_URL}/api/metric-names?${new URLSearchParams({
      from,
      to,
      q: "timeout",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!metricNamesRes.ok) {
    throw new Error(
      `metric-names failed: ${metricNamesRes.status} ${await metricNamesRes.text()}`,
    );
  }
  const metricNameList = (await metricNamesRes.json()) as { keys: Array<{ k: string }> };
  if (!metricNameList.keys.some((item) => item.k === "cpu_seconds")) {
    throw new Error(
      `expected cpu_seconds in metric-names, got ${metricNameList.keys.map((item) => item.k).join(",")}`,
    );
  }

  const metricSavedRes = await fetch(`${APP_URL}/api/saved-searches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e metric ${marker}`,
      query: "timeout",
      range: "1h",
      widgets: {
        logs: true,
        widgets: [
          {
            id: "a",
            kind: "timeseries",
            x: 0,
            y: 0,
            w: 12,
            h: 4,
            split: "level",
            chart: "stacked",
            metric: "cpu_seconds",
            metricLabels: { service: "api" },
          },
        ],
      },
    }),
  });
  if (!metricSavedRes.ok) {
    throw new Error(
      `metric saved search failed: ${metricSavedRes.status} ${await metricSavedRes.text()}`,
    );
  }
  const metricSaved = (await metricSavedRes.json()) as {
    id: string;
    widgets: {
      widgets: Array<{ metric?: string | null; metricLabels?: Record<string, string> }>;
    } | null;
  };
  if (
    metricSaved.widgets?.widgets[0]?.metric !== "cpu_seconds" ||
    metricSaved.widgets.widgets[0]?.metricLabels?.service !== "api"
  ) {
    throw new Error("saved search did not round-trip the metric source");
  }
  const metricSavedDel = await fetch(`${APP_URL}/api/saved-searches/${metricSaved.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!metricSavedDel.ok) {
    throw new Error(`delete metric saved search failed: ${metricSavedDel.status}`);
  }

  const facetsRes = await fetch(
    `${APP_URL}/api/facets?${new URLSearchParams({
      from,
      to,
      q: `service:e2e ${marker}`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!facetsRes.ok) {
    throw new Error(`facets failed: ${facetsRes.status} ${await facetsRes.text()}`);
  }
  const facets = (await facetsRes.json()) as {
    level: Array<{ v: string; n: number }>;
    service: Array<{ v: string; n: number }>;
    host: Array<{ v: string; n: number }>;
  };
  if (!facets.level.some((item) => item.v === "error" && item.n >= 1)) {
    throw new Error("expected an error level facet");
  }
  if (!facets.service.some((item) => item.v === "e2e")) {
    throw new Error("expected the e2e service facet");
  }
  if ("path" in facets) {
    throw new Error("core facets must not include attr keys");
  }

  const attrKeysRes = await fetch(
    `${APP_URL}/api/attr-keys?${new URLSearchParams({
      from,
      to,
      q: `service:e2e ${marker}`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!attrKeysRes.ok) {
    throw new Error(`attr-keys failed: ${attrKeysRes.status} ${await attrKeysRes.text()}`);
  }
  const attrKeys = (await attrKeysRes.json()) as {
    keys: Array<{ k: string; n: number }>;
  };
  if (!attrKeys.keys.some((item) => item.k === "path" && item.n >= 1)) {
    throw new Error("expected path in attr-keys");
  }

  const attrFacetsRes = await fetch(
    `${APP_URL}/api/attr-facets?${new URLSearchParams({
      from,
      to,
      q: `service:e2e ${marker}`,
      attrs: "path,status",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!attrFacetsRes.ok) {
    throw new Error(
      `attr-facets failed: ${attrFacetsRes.status} ${await attrFacetsRes.text()}`,
    );
  }
  const attrFacets = (await attrFacetsRes.json()) as Record<
    string,
    Array<{ v: string; n: number }>
  >;
  if (!attrFacets.path?.some((item) => item.v === "/e2e" && item.n >= 1)) {
    throw new Error("expected path=/e2e attr facet");
  }
  if (!attrFacets.status?.some((item) => item.v === "500")) {
    throw new Error("expected status=500 attr facet");
  }

  const pathSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `path:/e2e ${marker}`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!pathSearch.ok) {
    throw new Error(`path search failed: ${pathSearch.status} ${await pathSearch.text()}`);
  }
  const pathHits = (await pathSearch.json()) as {
    events: Array<{
      ts: string;
      service: string;
      host?: string;
      message: string;
      attrs?: Record<string, unknown>;
    }>;
  };
  if (!pathHits.events.some((event) => event.message === marker)) {
    throw new Error("path:/e2e did not return the ingested event");
  }
  const e2eEvent = pathHits.events.find((event) => event.message === marker);
  if (e2eEvent?.attrs?.status !== "500") {
    throw new Error("flattened attrs must stringify numbers (status=500)");
  }
  if (!e2eEvent) {
    throw new Error("missing e2e event");
  }
  const aroundRes = await fetch(
    `${APP_URL}/api/search/context?${new URLSearchParams({
      ts: e2eEvent.ts,
      service: e2eEvent.service,
      ...(e2eEvent.host ? { host: e2eEvent.host } : {}),
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!aroundRes.ok) {
    throw new Error(`surrounding failed: ${aroundRes.status} ${await aroundRes.text()}`);
  }
  const around = (await aroundRes.json()) as { before: unknown[]; after: unknown[] };
  if (!Array.isArray(around.before) || !Array.isArray(around.after)) {
    throw new Error("surrounding missing before/after");
  }

  const aroundToken = `around${Date.now()}`;
  const aroundPivotMs = Date.parse(from) + 90_000;
  const aroundBatch: Array<{
    ts: string;
    service: string;
    level: string;
    message: string;
  }> = [];
  const aroundServices = ["billing", "api", "worker"];
  for (let i = 5; i >= 1; i--) {
    aroundBatch.push({
      ts: new Date(aroundPivotMs - i).toISOString(),
      service: aroundServices[i % 3]!,
      level: "info",
      message: `${aroundToken} before${i}`,
    });
  }
  aroundBatch.push({
    ts: new Date(aroundPivotMs).toISOString(),
    service: "worker",
    level: "info",
    message: `${aroundToken} same`,
  });
  for (let i = 1; i <= 5; i++) {
    aroundBatch.push({
      ts: new Date(aroundPivotMs + i).toISOString(),
      service: aroundServices[i % 3]!,
      level: "info",
      message: `${aroundToken} after${i}`,
    });
  }
  const aroundIngest = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(aroundBatch),
  });
  if (!aroundIngest.ok) {
    throw new Error(
      `around ingest failed: ${aroundIngest.status} ${await aroundIngest.text()}`,
    );
  }
  const aroundFrom = new Date(aroundPivotMs - 10).toISOString();
  const aroundTo = new Date(aroundPivotMs + 10).toISOString();
  const aroundTs = new Date(aroundPivotMs).toISOString();
  let aroundHits: { before: Array<{ message: string; service: string }>; after: Array<{ message: string }> } | null =
    null;
  for (let i = 0; i < 40; i++) {
    const aroundTsRes = await fetch(
      `${APP_URL}/api/search/around?${new URLSearchParams({
        ts: aroundTs,
        from: aroundFrom,
        to: aroundTo,
        n: "3",
        q: aroundToken,
      }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!aroundTsRes.ok) {
      throw new Error(
        `around failed: ${aroundTsRes.status} ${await aroundTsRes.text()}`,
      );
    }
    const body = (await aroundTsRes.json()) as {
      before: Array<{ message: string; service: string }>;
      after: Array<{ message: string }>;
    };
    if (body.before.length === 3 && body.after.length === 3) {
      aroundHits = body;
      break;
    }
    await Bun.sleep(100);
  }
  if (!aroundHits) {
    throw new Error("GET /api/search/around did not return 3 before and 3 after");
  }
  if (
    aroundHits.before.map((row) => row.message).join(" ") !==
    `${aroundToken} before3 ${aroundToken} before2 ${aroundToken} before1`
  ) {
    throw new Error(
      `around before should be oldest-first closest 3, got ${aroundHits.before.map((row) => row.message).join(" ")}`,
    );
  }
  if (
    aroundHits.after.map((row) => row.message).join(" ") !==
    `${aroundToken} after1 ${aroundToken} after2 ${aroundToken} after3`
  ) {
    throw new Error(
      `around after should be closest-newer first, got ${aroundHits.after.map((row) => row.message).join(" ")}`,
    );
  }
  if (
    [...aroundHits.before, ...aroundHits.after].some((row) =>
      row.message.endsWith(" same"),
    )
  ) {
    throw new Error("around must not include the same-ms pivot row");
  }
  if (new Set(aroundHits.before.map((row) => row.service)).size < 2) {
    throw new Error("around must not pivot on service");
  }

  const rangeRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      range: "15m",
      q: marker,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!rangeRes.ok) {
    throw new Error(`range search failed: ${rangeRes.status} ${await rangeRes.text()}`);
  }
  const ranged = (await rangeRes.json()) as {
    events: Array<{ message: string }>;
    from: string | null;
    to: string | null;
  };
  if (!ranged.events.some((event) => event.message === marker)) {
    throw new Error("range=15m did not return the ingested event");
  }
  if (!ranged.from || !ranged.to) {
    throw new Error("range search must return resolved from/to");
  }

  const monthRes = await fetch(`${APP_URL}/api/search?range=30d&events=0`, {
    headers: { authorization: basicAuth() },
  });
  if (!monthRes.ok) {
    throw new Error(`range=30d failed: ${monthRes.status} ${await monthRes.text()}`);
  }
  const month = (await monthRes.json()) as { from: string | null; to: string | null };
  if (!month.from || !month.to) {
    throw new Error("range=30d must return resolved from/to");
  }
  const monthMs = Date.parse(month.to) - Date.parse(month.from);
  if (monthMs < 29 * 24 * 60 * 60 * 1000 || monthMs > 31 * 24 * 60 * 60 * 1000) {
    throw new Error(`range=30d span was ${monthMs}ms`);
  }
  const tooLong = await fetch(`${APP_URL}/api/search?range=366d`, {
    headers: { authorization: basicAuth() },
  });
  if (tooLong.status !== 400) {
    throw new Error(`expected 400 for range=366d, got ${tooLong.status}`);
  }

  const badRange = await fetch(`${APP_URL}/api/search?range=nope`, {
    headers: { authorization: basicAuth() },
  });
  if (badRange.status !== 400) {
    throw new Error(`expected 400 for invalid range, got ${badRange.status}`);
  }

  const createRes = await fetch(`${APP_URL}/api/saved-searches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e ${marker}`,
      query: `level:error ${marker}`,
      from_ts: from,
      to_ts: to,
      agg: "p99:duration_ms",
      widgets: {
        logs: false,
        widgets: [
          {
            id: "a",
            kind: "timeseries",
            x: 0,
            y: 0,
            w: 12,
            h: 4,
            split: "level",
            chart: "stacked",
            agg: "p99:duration_ms",
            replaceY: false,
            logScale: false,
            attr: null,
          },
          {
            id: "b",
            kind: "stat",
            x: 0,
            y: 4,
            w: 4,
            h: 2,
            split: "level",
            chart: "stacked",
            agg: "count",
            replaceY: false,
            logScale: false,
            attr: null,
          },
          {
            id: "c",
            kind: "hbar",
            x: 4,
            y: 4,
            w: 8,
            h: 3,
            split: "level",
            chart: "stacked",
            agg: null,
            replaceY: false,
            logScale: false,
            attr: "status",
          },
        ],
      },
      cols: ["status", "path", "user_id", "duration_ms"],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`save failed: ${createRes.status} ${await createRes.text()}`);
  }
  const saved = (await createRes.json()) as {
    id: string;
    agg: string | null;
    cols?: string[];
    widgets: { logs: boolean; widgets: Array<{ kind: string; attr?: string | null }> } | null;
  };
  if (saved.agg !== "p99:duration_ms") {
    throw new Error(`expected saved agg p99:duration_ms, got ${saved.agg}`);
  }
  if (
    !saved.cols ||
    saved.cols.join(",") !== "status,path,user_id"
  ) {
    throw new Error(`expected saved cols cap 3 [status,path,user_id], got ${JSON.stringify(saved.cols)}`);
  }
  if (
    saved.widgets?.logs !== false ||
    saved.widgets.widgets.length !== 3 ||
    saved.widgets.widgets[2]?.attr !== "status"
  ) {
    throw new Error("expected saved widgets with logs off, three cards, and status top-N");
  }
  const updateSaved = await fetch(`${APP_URL}/api/saved-searches/${saved.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e ${marker} updated`,
      query: `level:error ${marker}`,
      from_ts: from,
      to_ts: to,
    }),
  });
  if (!updateSaved.ok) {
    throw new Error(`update save failed: ${updateSaved.status} ${await updateSaved.text()}`);
  }
  const updated = (await updateSaved.json()) as { cols?: string[] };
  if (!updated.cols || updated.cols.join(",") !== "status,path,user_id") {
    throw new Error(`expected cols to survive a PUT that omits them, got ${JSON.stringify(updated.cols)}`);
  }
  const clearCols = await fetch(`${APP_URL}/api/saved-searches/${saved.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e ${marker} updated`,
      query: `level:error ${marker}`,
      from_ts: from,
      to_ts: to,
      cols: [],
    }),
  });
  if (!clearCols.ok) {
    throw new Error(`clear cols failed: ${clearCols.status} ${await clearCols.text()}`);
  }
  const cleared = (await clearCols.json()) as { cols?: string[] };
  if (cleared.cols && cleared.cols.length > 0) {
    throw new Error(`expected cols cleared, got ${JSON.stringify(cleared.cols)}`);
  }
  const restoreCols = await fetch(`${APP_URL}/api/saved-searches/${saved.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e ${marker} updated`,
      query: `level:error ${marker}`,
      from_ts: from,
      to_ts: to,
      cols: ["status", "path"],
    }),
  });
  if (!restoreCols.ok) {
    throw new Error(`restore cols failed: ${restoreCols.status} ${await restoreCols.text()}`);
  }
  const testRes = await fetch(`${APP_URL}/api/saved-searches/${saved.id}/test`, {
    method: "POST",
    headers: { authorization: basicAuth() },
  });
  if (!testRes.ok) {
    throw new Error(`test-query failed: ${testRes.status} ${await testRes.text()}`);
  }
  const tested = (await testRes.json()) as { count: number; value?: number };
  if (tested.count < 1) {
    throw new Error("test-query count expected >= 1");
  }

  const otlpMarker = `otlp${Date.now()}`;
  const otlpRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: { stringValue: otlpMarker },
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (!otlpRes.ok) {
    throw new Error(`otlp ingest failed: ${otlpRes.status} ${await otlpRes.text()}`);
  }
  const otlpIngested = (await otlpRes.json()) as { ingested: number };
  if (otlpIngested.ingested !== 1) {
    throw new Error(`expected otlp ingested=1, got ${otlpIngested.ingested}`);
  }
  const otlpSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: otlpMarker }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!otlpSearch.ok) {
    throw new Error(`otlp search failed: ${otlpSearch.status} ${await otlpSearch.text()}`);
  }
  const otlpFound = (await otlpSearch.json()) as { events: Array<{ message: string }> };
  if (!otlpFound.events.some((event) => event.message === otlpMarker)) {
    throw new Error("otlp event not searchable");
  }

  const otlpGzipMarker = `otlpgz${Date.now()}`;
  const otlpGzipJson = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                severityText: "ERROR",
                body: { stringValue: otlpGzipMarker },
              },
            ],
          },
        ],
      },
    ],
  });
  const otlpGzipRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: {
      "content-encoding": "gzip",
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: Bun.gzipSync(Buffer.from(otlpGzipJson)),
  });
  if (!otlpGzipRes.ok) {
    throw new Error(`otlp gzip ingest failed: ${otlpGzipRes.status} ${await otlpGzipRes.text()}`);
  }
  const otlpGzipSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: otlpGzipMarker }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!otlpGzipSearch.ok) {
    throw new Error(`otlp gzip search failed: ${otlpGzipSearch.status} ${await otlpGzipSearch.text()}`);
  }
  const otlpGzipFound = (await otlpGzipSearch.json()) as { events: Array<{ message: string }> };
  if (!otlpGzipFound.events.some((event) => event.message === otlpGzipMarker)) {
    throw new Error("otlp gzip event not searchable");
  }
  await expectOtlpGzipCap("/v1/logs");
  await expectOtlpGzipCap("/v1/traces");
  await expectOtlpGzipCap("/v1/profiles");

  const otlpProtoMarker = `otlpproto${Date.now()}`;
  const otlpProtoRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: Buffer.from(
      encodeOtlpProtobuf({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "otlp-e2e" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: { stringValue: otlpProtoMarker },
                },
              ],
            },
          ],
        },
      ],
    }),
    ),
  });
  if (!otlpProtoRes.ok) {
    throw new Error(
      `otlp protobuf ingest failed: ${otlpProtoRes.status} ${await otlpProtoRes.text()}`,
    );
  }
  const otlpProtoIngested = (await otlpProtoRes.json()) as { ingested: number };
  if (otlpProtoIngested.ingested !== 1) {
    throw new Error(`expected otlp protobuf ingested=1, got ${otlpProtoIngested.ingested}`);
  }
  const otlpProtoSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: otlpProtoMarker }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!otlpProtoSearch.ok) {
    throw new Error(
      `otlp protobuf search failed: ${otlpProtoSearch.status} ${await otlpProtoSearch.text()}`,
    );
  }
  const otlpProtoFound = (await otlpProtoSearch.json()) as {
    events: Array<{ message: string }>;
  };
  if (!otlpProtoFound.events.some((event) => event.message === otlpProtoMarker)) {
    throw new Error("otlp protobuf event not searchable");
  }

  const syslogMarker = `syslog${Date.now()}`;
  const syslogPort = Number(process.env.SYSLOG_UDP_PORT ?? "5514");
  const syslogPacket = formatSyslog3164({
    ts: new Date().toISOString(),
    service: "e2e-syslog",
    host: "e2e-1",
    level: "error",
    message: syslogMarker,
  });
  const udp = await Bun.udpSocket({});
  try {
    udp.send(syslogPacket, syslogPort, "127.0.0.1");
  } finally {
    udp.close();
  }
  let syslogFound = false;
  for (let i = 0; i < 40; i++) {
    const syslogSearch = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: syslogMarker }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!syslogSearch.ok) {
      throw new Error(
        `syslog search failed: ${syslogSearch.status} ${await syslogSearch.text()}`,
      );
    }
    const syslogHits = (await syslogSearch.json()) as {
      events: Array<{ message: string }>;
    };
    if (syslogHits.events.some((event) => event.message === syslogMarker)) {
      syslogFound = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!syslogFound) {
    throw new Error("syslog event not searchable");
  }

  const badOtlp = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ not: "otlp" }),
  });
  if (badOtlp.status !== 400) {
    throw new Error(`expected 400 for invalid OTLP, got ${badOtlp.status}`);
  }

  const tokenRes = await fetch(`${APP_URL}/api/api-tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({ name: `e2e-token ${marker}` }),
  });
  if (!tokenRes.ok) {
    throw new Error(`create token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const createdToken = (await tokenRes.json()) as { id: string; token: string };
  const tokenIngest = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${createdToken.token}`,
    },
    body: JSON.stringify({
      service: "e2e",
      level: "info",
      message: `token-${marker}`,
    }),
  });
  if (!tokenIngest.ok) {
    throw new Error(`token ingest failed: ${tokenIngest.status} ${await tokenIngest.text()}`);
  }
  const tokenDel = await fetch(`${APP_URL}/api/api-tokens/${createdToken.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!tokenDel.ok) {
    throw new Error(`delete token failed: ${tokenDel.status}`);
  }

  const metricsRes = await fetch(`${APP_URL}/api/metrics`);
  if (!metricsRes.ok) {
    throw new Error(`metrics failed: ${metricsRes.status}`);
  }
  const metricsText = await metricsRes.text();
  if (!metricsText.includes("toposcope_ingest_events_total")) {
    throw new Error("metrics missing ingest counter");
  }
  if (!metricsText.includes("toposcope_ingest_metrics_total")) {
    throw new Error("metrics missing metric ingest counter");
  }
  if (!metricsText.includes("toposcope_ingest_marks_total")) {
    throw new Error("metrics missing marks ingest counter");
  }

  const runRes = await fetch(`${APP_URL}/api/saved-searches/${saved.id}/run`, {
    headers: { authorization: basicAuth() },
  });
  if (!runRes.ok) {
    throw new Error(`run failed: ${runRes.status} ${await runRes.text()}`);
  }
  const ran = (await runRes.json()) as { count: number; events: unknown[] };
  if (ran.count < 1) {
    throw new Error("run count expected >= 1");
  }

  const alertRes = await fetch(`${APP_URL}/api/alert-rules`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e alert ${marker}`,
      saved_search_id: saved.id,
      threshold: 1,
      webhook_url: "http://127.0.0.1:9/unused",
    }),
  });
  if (!alertRes.ok) {
    throw new Error(`create alert failed: ${alertRes.status} ${await alertRes.text()}`);
  }
  const alert = (await alertRes.json()) as {
    id: string;
    consecutive_failures: number;
    last_attempt_at: number | null;
  };
  if (alert.consecutive_failures !== 0 || alert.last_attempt_at !== null) {
    throw new Error("new alert should have no webhook attempts yet");
  }
  const halfAlert = await fetch(`${APP_URL}/api/alert-rules/${alert.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({ threshold: 0.5 }),
  });
  if (!halfAlert.ok) {
    throw new Error(`threshold 0.5 failed: ${halfAlert.status} ${await halfAlert.text()}`);
  }
  const half = (await halfAlert.json()) as { threshold: number };
  if (half.threshold !== 0.5) {
    throw new Error(`expected threshold 0.5, got ${half.threshold}`);
  }
  const updateAlert = await fetch(`${APP_URL}/api/alert-rules/${alert.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({ threshold: 2 }),
  });
  if (!updateAlert.ok) {
    throw new Error(`update alert failed: ${updateAlert.status} ${await updateAlert.text()}`);
  }
  const updatedAlert = (await updateAlert.json()) as { threshold: number };
  if (updatedAlert.threshold !== 2) {
    throw new Error(`expected threshold 2, got ${updatedAlert.threshold}`);
  }
  const silenceRes = await fetch(`${APP_URL}/api/alert-rules/${alert.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      threshold: 2,
      webhook_url: "http://127.0.0.1:9/unused",
      silence_for: "1h",
    }),
  });
  if (!silenceRes.ok) {
    throw new Error(`silence failed: ${silenceRes.status} ${await silenceRes.text()}`);
  }
  const silenced = (await silenceRes.json()) as { silenced_until: number | null };
  if (!silenced.silenced_until || silenced.silenced_until <= Date.now()) {
    throw new Error("expected silenced_until in the future");
  }

  const p99SavedRes = await fetch(`${APP_URL}/api/saved-searches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e p99 ${marker}`,
      query: "service:e2e",
      from_ts: from,
      to_ts: to,
      agg: "p99:duration_ms",
    }),
  });
  if (!p99SavedRes.ok) {
    throw new Error(
      `p99 save failed: ${p99SavedRes.status} ${await p99SavedRes.text()}`,
    );
  }
  const p99Saved = (await p99SavedRes.json()) as { id: string };
  const p99TestRes = await fetch(
    `${APP_URL}/api/saved-searches/${p99Saved.id}/test`,
    { method: "POST", headers: { authorization: basicAuth() } },
  );
  if (!p99TestRes.ok) {
    throw new Error(
      `p99 test failed: ${p99TestRes.status} ${await p99TestRes.text()}`,
    );
  }
  const p99Tested = (await p99TestRes.json()) as {
    value: number;
    refused: boolean;
    agg: string | null;
  };
  if (p99Tested.refused || p99Tested.agg !== "p99:duration_ms") {
    throw new Error(`expected p99 test series, got ${JSON.stringify(p99Tested)}`);
  }
  if (typeof p99Tested.value !== "number" || p99Tested.value < 0.5) {
    throw new Error(`expected p99 value >= 0.5, got ${p99Tested.value}`);
  }

  const received: unknown[] = [];
  const hook = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST") {
        received.push(await req.json());
        return new Response("ok");
      }
      return new Response("no", { status: 404 });
    },
  });
  const p99AlertRes = await fetch(`${APP_URL}/api/alert-rules`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: basicAuth(),
    },
    body: JSON.stringify({
      name: `e2e p99 alert ${marker}`,
      saved_search_id: p99Saved.id,
      threshold: 0.5,
      webhook_url: `http://127.0.0.1:${hook.port}/hook`,
    }),
  });
  if (!p99AlertRes.ok) {
    hook.stop();
    throw new Error(
      `p99 alert failed: ${p99AlertRes.status} ${await p99AlertRes.text()}`,
    );
  }
  const p99Alert = (await p99AlertRes.json()) as { id: string };
  await evaluateAlerts();
  if (received.length < 1) {
    hook.stop();
    throw new Error("expected p99 alert to fire a webhook");
  }
  const fired = received.find((row) => {
    if (!row || typeof row !== "object") {
      return false;
    }
    return (row as { agg?: string | null }).agg === "p99:duration_ms";
  }) as { agg?: string | null; value?: number; count?: number } | undefined;
  if (!fired || typeof fired.value !== "number") {
    hook.stop();
    throw new Error(`webhook missing agg/value: ${JSON.stringify(received)}`);
  }
  hook.stop();
  const p99AlertDel = await fetch(`${APP_URL}/api/alert-rules/${p99Alert.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!p99AlertDel.ok) {
    throw new Error(`delete p99 alert failed: ${p99AlertDel.status}`);
  }
  const p99SavedDel = await fetch(`${APP_URL}/api/saved-searches/${p99Saved.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!p99SavedDel.ok) {
    throw new Error(`delete p99 search failed: ${p99SavedDel.status}`);
  }

  const blocked = await fetch(`${APP_URL}/api/saved-searches/${saved.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (blocked.status !== 409) {
    throw new Error(`expected 409 deleting referenced search, got ${blocked.status}`);
  }
  const alertDel = await fetch(`${APP_URL}/api/alert-rules/${alert.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!alertDel.ok) {
    throw new Error(`delete alert failed: ${alertDel.status}`);
  }

  const delRes = await fetch(`${APP_URL}/api/saved-searches/${saved.id}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });
  if (!delRes.ok) {
    throw new Error(`delete failed: ${delRes.status} ${await delRes.text()}`);
  }

  const fieldsPrevRes = await fetch(`${APP_URL}/api/fields?range=1h`, {
    headers: { authorization: basicAuth() },
  });
  if (!fieldsPrevRes.ok) {
    throw new Error(`fields get failed: ${fieldsPrevRes.status} ${await fieldsPrevRes.text()}`);
  }
  const fieldsPrev = (await fieldsPrevRes.json()) as {
    roles: Record<string, string>;
    links: Record<string, string>;
    keys: Array<{ key: string; values: number | "numeric" | null }>;
    suggestLinks: Record<string, string>;
  };
  const lookupKey = `e2e_uid_${marker.replaceAll("-", "_")}`;
  const systemKey = `e2e_sys_${marker.replaceAll("-", "_")}`;
  const hop = `e2e-hop-${marker}`;
  const putFields = async (
    roles: Record<string, string>,
    links: Record<string, string>,
  ) => {
    const res = await fetch(`${APP_URL}/api/fields?range=1h`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: basicAuth(),
      },
      body: JSON.stringify({ roles, links }),
    });
    return res;
  };
  try {
    const lookupPut = await putFields(
      { ...fieldsPrev.roles, [lookupKey]: "lookup" },
      fieldsPrev.links,
    );
    if (!lookupPut.ok) {
      throw new Error(`fields lookup put failed: ${lookupPut.status} ${await lookupPut.text()}`);
    }
    const lookupStored = (await lookupPut.json()) as {
      roles?: Record<string, string>;
      keys?: unknown;
    };
    if ("keys" in lookupStored) {
      throw new Error("fields PUT must return roles/links only");
    }
    if (lookupStored.roles?.[lookupKey] !== "lookup") {
      throw new Error("fields PUT must persist the lookup role");
    }
    const lookupIngest = await fetch(`${APP_URL}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        service: "e2e",
        level: "info",
        message: `${marker}fields`,
        attrs: {
          [lookupKey]: `id-${marker}`,
          status: 500,
          [systemKey]: hop,
        },
      }),
    });
    if (!lookupIngest.ok) {
      throw new Error(`fields ingest failed: ${lookupIngest.status}`);
    }
    const metricLinkRes = await fetch(`${APP_URL}/v1/metrics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        name: "cpu_seconds",
        value: 0.5,
        labels: { source: hop },
      }),
    });
    if (!metricLinkRes.ok) {
      throw new Error(`fields metric ingest failed: ${metricLinkRes.status}`);
    }

    let catalog: typeof fieldsPrev | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${APP_URL}/api/fields?range=1h`, {
        headers: { authorization: basicAuth() },
      });
      if (!res.ok) {
        throw new Error(`fields poll failed: ${res.status} ${await res.text()}`);
      }
      catalog = (await res.json()) as typeof fieldsPrev;
      const lookup = catalog.keys.find((row) => row.key === lookupKey);
      const status = catalog.keys.find((row) => row.key === "status");
      if (
        lookup &&
        status &&
        status.values !== null &&
        catalog.suggestLinks[systemKey] === "source"
      ) {
        break;
      }
      await Bun.sleep(200);
    }
    if (!catalog) {
      throw new Error("fields catalog missing");
    }
    const lookupRow = catalog.keys.find((row) => row.key === lookupKey);
    if (!lookupRow) {
      throw new Error(`expected ${lookupKey} on the fields catalog`);
    }
    if (lookupRow.values !== null) {
      throw new Error(`lookup key must be not charted, got ${String(lookupRow.values)}`);
    }
    const statusRow = catalog.keys.find((row) => row.key === "status");
    if (!statusRow || statusRow.values === null) {
      throw new Error("chart status must still roll up");
    }
    if (catalog.suggestLinks[systemKey] !== "source") {
      throw new Error(
        `expected ${systemKey} → source suggestion, got ${JSON.stringify(catalog.suggestLinks)}`,
      );
    }
    if (catalog.links[systemKey]) {
      throw new Error("overlap suggestion must not write a link");
    }

    const keysWaveRes = await fetch(`${APP_URL}/api/fields?range=1h&wave=keys`, {
      headers: { authorization: basicAuth() },
    });
    if (!keysWaveRes.ok) {
      throw new Error(`fields wave=keys failed: ${keysWaveRes.status}`);
    }
    const keysWave = (await keysWaveRes.json()) as typeof fieldsPrev;
    if (!keysWave.keys.some((row) => row.key === lookupKey)) {
      throw new Error("wave=keys must list the lookup key");
    }
    if (keysWave.suggestLinks[systemKey]) {
      throw new Error("wave=keys must not wait on link suggestions");
    }

    const valuesRes = await fetch(
      `${APP_URL}/api/attr-values?${new URLSearchParams({
        from,
        to,
        key: lookupKey,
      }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!valuesRes.ok) {
      throw new Error(`attr-values lookup failed: ${valuesRes.status}`);
    }
    const values = (await valuesRes.json()) as { values: Array<{ v: string }> };
    if (values.values.some((row) => row.v === `id-${marker}`)) {
      throw new Error("lookup value must be absent from the values rollup");
    }

    const overlayRes = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({
        from,
        to,
        q: `service:e2e ${marker}fields`,
        events: "0",
        metric: "cpu_seconds",
        ml: `source:${hop}`,
      }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!overlayRes.ok) {
      throw new Error(`graph overlay search failed: ${overlayRes.status}`);
    }
    const overlay = (await overlayRes.json()) as {
      agg?: { source: string; expr: string };
    };
    if (
      overlay.agg?.source !== "metric" ||
      overlay.agg.expr !== `cpu_seconds{source=${hop}}`
    ) {
      throw new Error(`expected source hop overlay, got ${JSON.stringify(overlay.agg)}`);
    }

    const nine: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      nine[`k${i}`] = "source";
    }
    const capRes = await putFields(fieldsPrev.roles, nine);
    if (capRes.status !== 400) {
      throw new Error(`expected 400 for a ninth link, got ${capRes.status}`);
    }
  } finally {
    const restore = await putFields(fieldsPrev.roles, fieldsPrev.links);
    if (!restore.ok) {
      throw new Error(`fields restore failed: ${restore.status} ${await restore.text()}`);
    }
  }

  const followHex = `${Date.now().toString(16).padStart(16, "0")}cafef00dcafef00d`.slice(0, 32);
  const followTs = Date.now();
  const followBatch = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify([
      {
        ts: new Date(followTs - 1000).toISOString(),
        service: "nginx",
        level: "info",
        message: `${marker}-follow-nginx`,
        attrs: { request_id: followHex },
      },
      {
        ts: new Date(followTs).toISOString(),
        service: "wordpress",
        level: "info",
        message: `${marker}-follow-wp`,
        attrs: { request_id: followHex },
      },
      {
        ts: new Date(followTs + 1000).toISOString(),
        service: "mysql",
        level: "info",
        message: `${marker}-follow-mysql`,
        attrs: { request_id: followHex },
      },
    ]),
  });
  if (!followBatch.ok) {
    throw new Error(`follow ingest failed: ${followBatch.status} ${await followBatch.text()}`);
  }
  const followDeadline = Date.now() + 10_000;
  let followSearch: {
    events: Array<{ service: string }>;
    total: number;
    histogram: Array<{ n: number }>;
  } | null = null;
  while (Date.now() < followDeadline) {
    const res = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({
        from,
        to,
        q: `request_id:${followHex}`,
      }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    if (!res.ok) {
      throw new Error(`follow search failed: ${res.status} ${await res.text()}`);
    }
    followSearch = (await res.json()) as {
      events: Array<{ service: string }>;
      total: number;
      histogram: Array<{ n: number }>;
    };
    if (followSearch.total >= 3) {
      break;
    }
    await Bun.sleep(200);
  }
  if (!followSearch) {
    throw new Error("follow search missing");
  }
  const histTotal = followSearch.histogram.reduce((sum, bucket) => sum + bucket.n, 0);
  if (followSearch.total !== histTotal) {
    throw new Error(
      `follow histogram total ${histTotal} must match search total ${followSearch.total}`,
    );
  }
  if (followSearch.total !== 3) {
    throw new Error(`expected 3 follow hits, got ${followSearch.total}`);
  }
  const followServices = new Set(followSearch.events.map((event) => event.service));
  if (!followServices.has("nginx") || !followServices.has("wordpress") || !followServices.has("mysql")) {
    throw new Error(`follow must drop service: and return every hop, got ${[...followServices]}`);
  }
  if (followSearch.events.some((event) => event.service === undefined)) {
    throw new Error("follow events missing service");
  }

  const traceId = Date.now().toString(16).padStart(32, "0").slice(-32);
  const nginxSpan = "a1".padEnd(16, "0");
  const wpSpan = "a2".padEnd(16, "0");
  const mysqlSpan = "a3".padEnd(16, "0");
  const treeTs = new Date().toISOString();
  const tree: Span[] = [
    {
      trace_id: traceId,
      span_id: nginxSpan,
      parent_span_id: "",
      service: "nginx",
      name: "GET /wp-admin/post.php",
      ts: treeTs,
      duration_ms: 412,
      status: "ok",
      attrs: { "http.method": "GET" },
    },
    {
      trace_id: traceId,
      span_id: wpSpan,
      parent_span_id: nginxSpan,
      service: "wordpress",
      name: "do_action(save_post)",
      ts: treeTs,
      duration_ms: 388,
      status: "unset",
      attrs: {},
    },
    {
      trace_id: traceId,
      span_id: mysqlSpan,
      parent_span_id: wpSpan,
      service: "mysql",
      name: "SELECT wp_options",
      ts: treeTs,
      duration_ms: 211,
      status: "error",
      attrs: { "status.message": "timeout" },
    },
  ];
  const tracesRes = await fetch(`${APP_URL}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(toOtlpTracesJson(tree)),
  });
  if (!tracesRes.ok) {
    throw new Error(`traces ingest failed: ${tracesRes.status} ${await tracesRes.text()}`);
  }
  const tracesIngested = (await tracesRes.json()) as { ingested: number };
  if (tracesIngested.ingested !== 3) {
    throw new Error(`expected traces ingested=3, got ${tracesIngested.ingested}`);
  }

  const protoTraceId = `b${traceId.slice(1)}`;
  const protoSpan: Span = {
    ...tree[0]!,
    trace_id: protoTraceId,
    span_id: "b1".padEnd(16, "0"),
    name: "GET /protobuf",
  };
  const tracesProtoRes = await fetch(`${APP_URL}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: Buffer.from(encodeOtlpTracesProtobuf(toOtlpTracesJson([protoSpan]))),
  });
  if (!tracesProtoRes.ok) {
    throw new Error(
      `traces protobuf ingest failed: ${tracesProtoRes.status} ${await tracesProtoRes.text()}`,
    );
  }

  const logWithTrace = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      service: "nginx",
      level: "info",
      message: `trace-join-${marker}`,
      attrs: { trace_id: traceId },
    }),
  });
  if (!logWithTrace.ok) {
    throw new Error(`trace log ingest failed: ${logWithTrace.status} ${await logWithTrace.text()}`);
  }

  const treeGet = await fetch(`${APP_URL}/api/traces/${traceId}`, {
    headers: { authorization: basicAuth() },
  });
  if (!treeGet.ok) {
    throw new Error(`trace get failed: ${treeGet.status} ${await treeGet.text()}`);
  }
  const treeJson = (await treeGet.json()) as {
    spans: Array<{
      service: string;
      span_id: string;
      parent_span_id: string;
      duration_ms: number;
    }>;
    total: number;
  };
  if (treeJson.total !== 3 || treeJson.spans.length !== 3) {
    throw new Error(`expected 3 spans, got total=${treeJson.total} n=${treeJson.spans.length}`);
  }
  const byId = new Map(treeJson.spans.map((span) => [span.span_id, span]));
  if (byId.get(wpSpan)?.parent_span_id !== nginxSpan) {
    throw new Error("wordpress span must sit under nginx");
  }
  if (byId.get(mysqlSpan)?.parent_span_id !== wpSpan) {
    throw new Error("mysql span must sit under wordpress");
  }
  const nginxMs = byId.get(nginxSpan)?.duration_ms ?? 0;
  if (Math.abs(nginxMs - 412) > 0.05) {
    throw new Error(`nginx duration wanted 412, got ${nginxMs}`);
  }

  const protoGet = await fetch(`${APP_URL}/api/traces/${protoTraceId}`, {
    headers: { authorization: basicAuth() },
  });
  if (!protoGet.ok) {
    throw new Error(`protobuf trace get failed: ${protoGet.status} ${await protoGet.text()}`);
  }
  const protoJson = (await protoGet.json()) as { spans: unknown[]; total: number };
  if (protoJson.total !== 1) {
    throw new Error(`expected protobuf trace total=1, got ${protoJson.total}`);
  }

  const emptyTrace = await fetch(`${APP_URL}/api/traces/${"e".repeat(32)}`, {
    headers: { authorization: basicAuth() },
  });
  if (emptyTrace.status !== 200) {
    throw new Error(`empty trace must be 200, got ${emptyTrace.status}`);
  }
  const emptyJson = (await emptyTrace.json()) as { spans: unknown[]; total: number };
  if (emptyJson.total !== 0 || emptyJson.spans.length !== 0) {
    throw new Error("empty trace must be { spans: [], total: 0 }");
  }

  const junkTrace = await fetch(`${APP_URL}/api/traces/req-foo`, {
    headers: { authorization: basicAuth() },
  });
  if (junkTrace.status !== 400) {
    throw new Error(`junk trace id must be 400, got ${junkTrace.status}`);
  }

  const overflow: Span[] = Array.from({ length: 501 }, (_, i) => ({
    trace_id: "f".repeat(32),
    span_id: (i + 1).toString(16).padStart(16, "0"),
    parent_span_id: "",
    service: "overflow",
    name: "span",
    ts: treeTs,
    duration_ms: 1,
    status: "unset",
    attrs: {},
  }));
  const overflowRes = await fetch(`${APP_URL}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(toOtlpTracesJson(overflow)),
  });
  if (overflowRes.status !== 400) {
    throw new Error(`expected 400 for 501 spans, got ${overflowRes.status}`);
  }

  const profileTs = new Date().toISOString();
  const wpProfile = {
    service: "wordpress",
    ts: profileTs,
    duration_ms: 10_000,
    profile_id: "c1".padEnd(32, "0"),
    samples: [
      {
        frames: ["{main}", "edit_post", "do_action(save_post)"],
        value: 47_000_000,
        trace_id: traceId,
        span_id: wpSpan,
      },
      {
        frames: ["{main}", "wp_mail"],
        value: 12_000_000,
      },
    ],
  };
  const profilesRes = await fetch(`${APP_URL}/v1/profiles`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(toOtlpProfilesJson([wpProfile])),
  });
  if (!profilesRes.ok) {
    throw new Error(`profiles ingest failed: ${profilesRes.status} ${await profilesRes.text()}`);
  }
  const profilesIngested = (await profilesRes.json()) as { ingested: number };
  if (profilesIngested.ingested !== 2) {
    throw new Error(`expected profiles ingested=2, got ${profilesIngested.ingested}`);
  }

  const laterProfile = {
    ...wpProfile,
    ts: new Date(Date.parse(profileTs) + 1000).toISOString(),
    profile_id: "c2".padEnd(32, "0"),
    samples: [
      {
        frames: ["{main}", "do_action(save_post)", "seo_plugin::analyse"],
        value: 31_000_000,
        trace_id: traceId,
        span_id: wpSpan,
      },
    ],
  };
  const secondRes = await fetch(`${APP_URL}/v1/profiles`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(toOtlpProfilesJson([laterProfile])),
  });
  if (!secondRes.ok) {
    throw new Error(`second profile ingest failed: ${secondRes.status} ${await secondRes.text()}`);
  }

  const wpGet = await fetch(
    `${APP_URL}/api/profiles?${new URLSearchParams({ trace_id: traceId, span_id: wpSpan })}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!wpGet.ok) {
    throw new Error(`profile get failed: ${wpGet.status} ${await wpGet.text()}`);
  }
  const wpJson = (await wpGet.json()) as {
    stacks: Array<{ frames: string[]; value: number }>;
    total_samples: number;
    total_profiles: number;
    profile_id: string;
  };
  if (wpJson.total_profiles !== 2) {
    throw new Error(`expected total_profiles=2, got ${wpJson.total_profiles}`);
  }
  if (wpJson.profile_id !== laterProfile.profile_id) {
    throw new Error(`expected latest profile ${laterProfile.profile_id}, got ${wpJson.profile_id}`);
  }
  if (wpJson.stacks.length !== 1 || wpJson.stacks[0]?.frames[2] !== "seo_plugin::analyse") {
    throw new Error(`latest profile stacks were merged or wrong: ${JSON.stringify(wpJson.stacks)}`);
  }
  if (wpJson.stacks.some((stack) => stack.frames.includes("wp_mail"))) {
    throw new Error("unlinked wp_mail sample must not appear on the span GET");
  }

  const mysqlGet = await fetch(
    `${APP_URL}/api/profiles?${new URLSearchParams({ trace_id: traceId, span_id: mysqlSpan })}`,
    { headers: { authorization: basicAuth() } },
  );
  if (mysqlGet.status !== 200) {
    throw new Error(`empty profile must be 200, got ${mysqlGet.status}`);
  }
  const mysqlJson = (await mysqlGet.json()) as { stacks: unknown[]; total_samples: number };
  if (mysqlJson.total_samples !== 0 || mysqlJson.stacks.length !== 0) {
    throw new Error("mysql span must be an empty profile");
  }

  const protoProfileId = "c3".padEnd(32, "0");
  const protoProfRes = await fetch(`${APP_URL}/v1/profiles`, {
    method: "POST",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: Buffer.from(
      encodeOtlpProfilesProtobuf(
        toOtlpProfilesJson([
          {
            service: "wordpress",
            ts: profileTs,
            duration_ms: 1000,
            profile_id: protoProfileId,
            samples: [
              {
                frames: ["{main}", "protobuf_frame"],
                value: 9,
                trace_id: protoTraceId,
                span_id: protoSpan.span_id,
              },
            ],
          },
        ]),
      ),
    ),
  });
  if (!protoProfRes.ok) {
    throw new Error(
      `profiles protobuf ingest failed: ${protoProfRes.status} ${await protoProfRes.text()}`,
    );
  }
  const protoProfGet = await fetch(
    `${APP_URL}/api/profiles?${new URLSearchParams({
      trace_id: protoTraceId,
      span_id: protoSpan.span_id,
    })}`,
    { headers: { authorization: basicAuth() } },
  );
  const protoProfJson = (await protoProfGet.json()) as {
    stacks: Array<{ frames: string[] }>;
    total_samples: number;
  };
  if (protoProfJson.total_samples !== 1 || protoProfJson.stacks[0]?.frames[1] !== "protobuf_frame") {
    throw new Error(`protobuf profile GET wrong: ${JSON.stringify(protoProfJson)}`);
  }

  const overflowProfiles = await fetch(`${APP_URL}/v1/profiles`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(
      toOtlpProfilesJson(
        Array.from({ length: 501 }, (_, i) => ({
          service: "overflow",
          ts: profileTs,
          duration_ms: 1,
          profile_id: i.toString(16).padStart(32, "0"),
          samples: [],
        })),
      ),
    ),
  });
  if (overflowProfiles.status !== 400) {
    throw new Error(`expected 400 for 501 profiles, got ${overflowProfiles.status}`);
  }

  const live = await runLiveLoad({
    ...parseLiveArgs(["--logs=30", "--metrics=6", "--traces=4", "--for=2s"]),
    quiet: true,
  });
  if (live.logs < 8) {
    throw new Error(`load:live sent too few logs: ${live.logs}`);
  }
  const liveSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: live.marker }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!liveSearch.ok) {
    throw new Error(`live search failed: ${liveSearch.status} ${await liveSearch.text()}`);
  }
  const liveFound = (await liveSearch.json()) as { total: number };
  if (liveFound.total < 1) {
    throw new Error(`load:live marker ${live.marker} not searchable`);
  }
  const versionSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: "version:v0.9" }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!versionSearch.ok) {
    throw new Error(`version search failed: ${versionSearch.status} ${await versionSearch.text()}`);
  }
  const versionFound = (await versionSearch.json()) as { total: number };
  if (versionFound.total < 1) {
    throw new Error("load:live version:v0.9 not searchable");
  }
  const fingerprintSearch = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      range: "15m",
      q: `e1:${fakeFramedFingerprint()}`,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!fingerprintSearch.ok) {
    throw new Error(
      `fingerprint search failed: ${fingerprintSearch.status} ${await fingerprintSearch.text()}`,
    );
  }
  const fingerprintFound = (await fingerprintSearch.json()) as { total: number };
  if (fingerprintFound.total < 1) {
    throw new Error("load:live e1 fingerprint not searchable");
  }
  const keptId = live.kept[0];
  if (!keptId) {
    throw new Error("load:live posted no kept traces");
  }
  const keptGet = await fetch(`${APP_URL}/api/traces/${keptId}`, {
    headers: { authorization: basicAuth() },
  });
  if (!keptGet.ok) {
    throw new Error(`live kept trace failed: ${keptGet.status} ${await keptGet.text()}`);
  }
  const keptJson = (await keptGet.json()) as { spans: unknown[]; total: number };
  if (keptJson.total < 3) {
    throw new Error(`live kept trace wanted 3 spans, got ${keptJson.total}`);
  }
  const orphanId = live.sampledOut[0] ?? "d".repeat(32);
  const orphanGet = await fetch(`${APP_URL}/api/traces/${orphanId}`, {
    headers: { authorization: basicAuth() },
  });
  if (orphanGet.status !== 200) {
    throw new Error(`live orphan must be 200, got ${orphanGet.status}`);
  }
  const orphanJson = (await orphanGet.json()) as { spans: unknown[]; total: number };
  if (orphanJson.total !== 0) {
    throw new Error("live sampled-out id must be empty");
  }

  console.log("e2e ok: ingest → search → surrounding → otlp protobuf → syslog → token → run → alert series fire → follow-id → traces → profiles → load:live");
}

await main();
