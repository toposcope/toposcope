import http2 from "node:http2";
import net from "node:net";
import { toOtlpJson } from "../src/ingest/otlp";
import { grpcFrame } from "../src/ingest/otlp-grpc";
import { encodeOtlpProtobuf } from "../src/ingest/otlp-protobuf";
import { encodeOtlpMetricsProtobuf } from "../src/ingest/otlp-metrics-protobuf";
import { decodeOtlpReply } from "../src/ingest/otlp-reply";
import { toOtlpProfilesJson } from "../src/ingest/otlp-profiles";
import { encodeOtlpProfilesProtobuf } from "../src/ingest/otlp-profiles-protobuf";
import { toOtlpTracesJson } from "../src/ingest/otlp-traces";
import { encodeOtlpTracesProtobuf } from "../src/ingest/otlp-traces-protobuf";
import { formatSyslog3164 } from "../src/ingest/syslog-parse";
import { evaluateAlerts, monitorTick } from "../src/alerts/cron";
import { makeCerts, readCerts, startStands } from "./http-stands";
import { startNetStands } from "./net-stands";
import { cantTellHeld } from "../src/alerts/cant-tell";
import { getAlert } from "../src/control/alerts";
import { runLiveLoad } from "./load-live";
import { parseLiveArgs } from "./load-rates";
import { envValue } from "../src/shared/env";
import { fakeFramedFingerprint } from "../src/shared/fake-event";
import type { Span } from "../src/shared/span";
import { liftException } from "../src/shared/exception";
import { withFingerprint } from "../src/shared/fingerprint";
import { guideExamples, guideSection } from "./ingest-guide-examples";

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

  // The ingest guide's "What an app sends" examples, with only the event time moved to now.
  const guideMd = await Bun.file(`${import.meta.dir}/../docs/ingest.md`).text();
  const guideRows = guideExamples(guideSection(guideMd, "What an app sends"));
  if (guideRows.length !== 2) {
    throw new Error(`expected 2 examples in the ingest guide section, got ${guideRows.length}`);
  }
  const guideNowMs = Date.now();
  for (const example of guideRows) {
    const guideRes = await fetch(`${APP_URL}${example.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(example.body)
        .replace(/"ts":"[^"]+"/, `"ts":"${new Date(guideNowMs).toISOString()}"`)
        .replace(/"timeUnixNano":"\d+"/, `"timeUnixNano":"${BigInt(guideNowMs) * 1_000_000n}"`),
    });
    const guideIngested = (await guideRes.json()) as { ingested?: number };
    if (guideRes.status !== 200 || guideIngested.ingested !== 1) {
      throw new Error(
        `ingest guide example for ${example.path} was not stored: ${guideRes.status} ${JSON.stringify(guideIngested)}`,
      );
    }
  }
  const guideDirect = guideRows.find((example) => example.path === "/api/ingest")?.body as
    | { message: string; attrs: Record<string, unknown> }
    | undefined;
  const guideE1 = guideDirect
    ? withFingerprint("error", guideDirect.message, liftException(guideDirect.attrs))?.e1
    : undefined;
  if (typeof guideE1 !== "string") {
    throw new Error("ingest guide direct-post example has no fingerprint");
  }
  const guideSearch = await fetch(
    `${APP_URL}/api/search?q=${encodeURIComponent(`e1:${guideE1}`)}&range=15m`,
    { headers: { authorization: basicAuth() } },
  );
  const guideFound = (await guideSearch.json()) as {
    total: number;
    events: Array<{ service: string; attrs?: Record<string, string> }>;
  };
  if (guideFound.total < 2) {
    throw new Error(`ingest guide examples should share one e1; found ${guideFound.total} rows for ${guideE1}`);
  }
  for (const event of guideFound.events) {
    if (
      event.service !== "billing" ||
      event.attrs?.version !== "1.4.2" ||
      !event.attrs?.["exception.frames"]
    ) {
      throw new Error(`ingest guide example row is missing a field: ${JSON.stringify(event)}`);
    }
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

  const splitHosts = ["billing-1", "billing-2", "billing-3"] as const;
  const splitIngestRes = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(
      splitHosts.map((host) => ({
        service: "billing",
        host,
        level: "error",
        message: marker,
      })),
    ),
  });
  if (!splitIngestRes.ok) {
    throw new Error(
      `split ingest failed: ${splitIngestRes.status} ${await splitIngestRes.text()}`,
    );
  }
  const splitSearchRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({
      from,
      to,
      q: `level:error service:billing ${marker}`,
      split: "host",
      events: "0",
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!splitSearchRes.ok) {
    throw new Error(
      `host split search failed: ${splitSearchRes.status} ${await splitSearchRes.text()}`,
    );
  }
  const splitSearch = (await splitSearchRes.json()) as {
    histogram: Array<{ series: Record<string, number> }>;
  };
  const splitKeys = new Set(
    splitSearch.histogram.flatMap((bucket) => Object.keys(bucket.series)),
  );
  for (const host of splitHosts) {
    if (!splitKeys.has(host)) {
      throw new Error(`host split missing ${host}, keys=${[...splitKeys]}`);
    }
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
  const markIngested = (await markRes.json()) as { ingested: number; id?: string };
  if (markIngested.ingested !== 1) {
    throw new Error(`expected 1 change mark, got ${markIngested.ingested}`);
  }
  if (typeof markIngested.id !== "string" || !markIngested.id.startsWith("mk_")) {
    throw new Error(`expected minted mark id, got ${JSON.stringify(markIngested.id)}`);
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
  const cutBody = (await cutGet.json()) as {
    sets?: Array<{ id: string; waiting?: { haveMs: number; needMs: number } }>;
    title?: string;
    windows?: { sideMs: number; beforeMs: number; waiting: boolean; inside: unknown[] };
  };
  if (!Array.isArray(cutBody.sets) || typeof cutBody.title !== "string") {
    throw new Error("GET /api/search/cut missing sets or title");
  }
  // #111: a mark minutes old is compared with the hour before it, and Stopped waits.
  if (
    !cutBody.windows ||
    cutBody.windows.beforeMs !== 3_600_000 ||
    !cutBody.windows.waiting ||
    !Array.isArray(cutBody.windows.inside)
  ) {
    throw new Error(
      `GET /api/search/cut expected an hour before a young mark, got ${JSON.stringify(cutBody.windows)}`,
    );
  }
  const stoppedSet = cutBody.sets.find((set) => set.id === "stopped");
  if (cutBody.sets.length > 0 && stoppedSet?.waiting?.needMs !== 3_600_000) {
    throw new Error(`GET /api/search/cut expected Stopped to wait, got ${JSON.stringify(stoppedSet)}`);
  }
  const incidentEnd = new Date(Date.parse(markTs) + 60_000).toISOString();
  const incidentId = `e2e-inc-${Date.now()}`;
  const incidentRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-inc",
      id: incidentId,
      ts: markTs,
      end_ts: incidentEnd,
    }),
  });
  if (!incidentRes.ok) {
    throw new Error(
      `incident mark ingest failed: ${incidentRes.status} ${await incidentRes.text()}`,
    );
  }
  const incidentPosted = (await incidentRes.json()) as {
    ingested: number;
    id?: string;
  };
  if (incidentPosted.ingested !== 1 || incidentPosted.id !== incidentId) {
    throw new Error(
      `expected incident ingested=1 id=${incidentId}, got ${JSON.stringify(incidentPosted)}`,
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
  const incident = incidentBody.marks.find((mark) => mark.id === incidentId);
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
      id: incidentId,
      ts: markTs,
      end_ts: incidentEnd,
    }),
  });
  if (!incidentRetry.ok) {
    throw new Error(
      `incident mark retry failed: ${incidentRetry.status} ${await incidentRetry.text()}`,
    );
  }
  const incidentRetryBody = (await incidentRetry.json()) as {
    ingested: number;
    id?: string;
  };
  if (incidentRetryBody.ingested !== 0) {
    throw new Error(
      `expected 0 ingested on duplicate mark id, got ${incidentRetryBody.ingested}`,
    );
  }
  if (incidentRetryBody.id !== incidentId) {
    throw new Error(
      `expected closed-id retry to return id ${incidentId}, got ${JSON.stringify(incidentRetryBody.id)}`,
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
    (mark) => mark.id === incidentId,
  ).length;
  if (incidentDupCount !== 1) {
    throw new Error(`expected 1 mark for ${incidentId}, got ${incidentDupCount}`);
  }
  const closeId = `e2e-inc-close-${Date.now()}`;
  const openRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-close",
      id: closeId,
      ts: markTs,
    }),
  });
  if (!openRes.ok) {
    throw new Error(`open mark ingest failed: ${openRes.status} ${await openRes.text()}`);
  }
  const openBody = (await openRes.json()) as { ingested: number; id?: string };
  if (openBody.ingested !== 1 || openBody.id !== closeId) {
    throw new Error(`expected open ingested=1 id=${closeId}, got ${JSON.stringify(openBody)}`);
  }
  const openRetry = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-close",
      id: closeId,
    }),
  });
  if (!openRetry.ok) {
    throw new Error(`open mark retry failed: ${openRetry.status} ${await openRetry.text()}`);
  }
  const openRetryBody = (await openRetry.json()) as { ingested: number; id?: string };
  if (openRetryBody.ingested !== 0 || openRetryBody.id !== closeId) {
    throw new Error(
      `expected O1 skip ingested=0 id=${closeId}, got ${JSON.stringify(openRetryBody)}`,
    );
  }
  const closeRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-close",
      id: closeId,
      end_ts: incidentEnd,
    }),
  });
  if (!closeRes.ok) {
    throw new Error(`close mark ingest failed: ${closeRes.status} ${await closeRes.text()}`);
  }
  const closeBody = (await closeRes.json()) as { ingested: number; id?: string };
  if (closeBody.ingested !== 1 || closeBody.id !== closeId) {
    throw new Error(`expected close ingested=1 id=${closeId}, got ${JSON.stringify(closeBody)}`);
  }
  const closedGet = await fetch(
    `${APP_URL}/api/marks?${new URLSearchParams({ range: "15m" }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!closedGet.ok) {
    throw new Error(`closed marks list failed: ${closedGet.status} ${await closedGet.text()}`);
  }
  const closedList = (await closedGet.json()) as {
    marks: Array<{ id: string; ts?: string; end_ts: string | null }>;
  };
  const closedMark = closedList.marks.find((mark) => mark.id === closeId);
  if (!closedMark || closedMark.end_ts == null) {
    throw new Error("closed mark missing end_ts on GET /api/marks");
  }
  if (closedMark.ts && Date.parse(closedMark.ts) !== Date.parse(markTs)) {
    throw new Error(
      `close moved start ts: open ${markTs}, glyph ${closedMark.ts}`,
    );
  }
  const closeRetry = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      kind: "incident",
      title: "e2e-close",
      id: closeId,
      end_ts: incidentEnd,
    }),
  });
  const closeRetryBody = (await closeRetry.json()) as { ingested: number };
  if (!closeRetry.ok || closeRetryBody.ingested !== 0) {
    throw new Error(
      `expected X3 skip after close, got ${closeRetry.status} ${JSON.stringify(closeRetryBody)}`,
    );
  }
  const batchId = `e2e-inc-batch-${Date.now()}`;
  const batchRes = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify([
      { kind: "incident", title: "e2e-batch", id: batchId, ts: markTs },
      {
        kind: "incident",
        title: "e2e-batch",
        id: batchId,
        end_ts: incidentEnd,
      },
    ]),
  });
  if (!batchRes.ok) {
    throw new Error(`batch open+close failed: ${batchRes.status} ${await batchRes.text()}`);
  }
  const batchBody = (await batchRes.json()) as { ingested: number; ids?: string[] };
  if (batchBody.ingested !== 2 || JSON.stringify(batchBody.ids) !== JSON.stringify([batchId, batchId])) {
    throw new Error(`expected batch ingested=2 ids twice, got ${JSON.stringify(batchBody)}`);
  }
  const unauthorizedMarks = await fetch(`${APP_URL}/v1/marks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "deploy", title: "v0.9" }),
  });
  if (unauthorizedMarks.status !== 401) {
    throw new Error(`expected 401 for /v1/marks without auth, got ${unauthorizedMarks.status}`);
  }

  const probeService = `probe-${marker}`;
  const probeTs = new Date().toISOString();
  const probeAttach = await fetch(`${APP_URL}/v1/probes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      service: probeService,
      up: 0,
      ts: probeTs,
      // An attached check is also a push monitor's result (#177): a name of this run's, deleted below.
      check: `github_${marker}`,
    }),
  });
  if (!probeAttach.ok) {
    throw new Error(`probe attach failed: ${probeAttach.status} ${await probeAttach.text()}`);
  }
  const probeAttached = (await probeAttach.json()) as { ingested: number; up?: number };
  if (probeAttached.ingested !== 1 || probeAttached.up !== 0) {
    throw new Error(`expected attach up=0, got ${JSON.stringify(probeAttached)}`);
  }
  await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(`github_${marker}`)}`, {
    method: "DELETE",
    headers: { authorization: basicAuth() },
  });

  const downServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("down", { status: 503 });
    },
  });
  const probePull = await fetch(`${APP_URL}/v1/probes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      service: probeService,
      url: `http://127.0.0.1:${downServer.port}/health`,
      check: "k8s",
    }),
  });
  downServer.stop();
  if (!probePull.ok) {
    throw new Error(`probe pull failed: ${probePull.status} ${await probePull.text()}`);
  }
  const probePulled = (await probePull.json()) as { ingested: number; up?: number };
  if (probePulled.ingested !== 1 || probePulled.up !== 0) {
    throw new Error(`expected failed pull up=0, got ${JSON.stringify(probePulled)}`);
  }

  const probesGet = await fetch(
    `${APP_URL}/api/probes?${new URLSearchParams({
      range: "15m",
      service: probeService,
    }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  if (!probesGet.ok) {
    throw new Error(`probes list failed: ${probesGet.status} ${await probesGet.text()}`);
  }
  const probesBody = (await probesGet.json()) as {
    probes: Array<{ up: number; service: string }>;
  };
  if (!probesBody.probes.some((sample) => sample.up === 0 && sample.service === probeService)) {
    throw new Error(`GET /api/probes missing up=0 for ${probeService}`);
  }

  const unauthorizedProbes = await fetch(`${APP_URL}/v1/probes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "billing", up: 1 }),
  });
  if (unauthorizedProbes.status !== 401) {
    throw new Error(`expected 401 for /v1/probes without auth, got ${unauthorizedProbes.status}`);
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

  // OTLP metrics: a counter sent as deltas reads as a sum, a gauge as an average, a running total is
  // converted, and a histogram keeps its buckets.
  const otlpMetricRun = Date.now();
  const otlpCounter = `e2e.jobs.c${otlpMetricRun}`;
  const otlpGauge = `e2e.memory.g${otlpMetricRun}`;
  const otlpHistogram = `e2e.latency.h${otlpMetricRun}`;
  const otlpNano = String((Date.now() - 30_000) * 1_000_000);
  const otlpMetricsBody = {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: otlpCounter,
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    { timeUnixNano: otlpNano, asInt: "5" },
                    { timeUnixNano: otlpNano, asInt: "7" },
                  ],
                },
              },
              {
                name: otlpGauge,
                gauge: {
                  dataPoints: [
                    { timeUnixNano: otlpNano, asDouble: 10 },
                    { timeUnixNano: otlpNano, asDouble: 20 },
                  ],
                },
              },
              {
                // 50 up to 100, 40 up to 200, 10 up to 400.
                name: otlpHistogram,
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      timeUnixNano: otlpNano,
                      count: "100",
                      sum: 14_000,
                      bucketCounts: ["50", "40", "10", "0"],
                      explicitBounds: [100, 200, 400],
                    },
                  ],
                },
              },
              {
                name: `e2e.untold.u${otlpMetricRun}`,
                sum: { isMonotonic: true, dataPoints: [{ timeUnixNano: otlpNano, asInt: "1" }] },
              },
            ],
          },
        ],
      },
    ],
  };
  const otlpMetricsRes = await fetch(`${APP_URL}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify(otlpMetricsBody),
  });
  const otlpMetricsReply = (await otlpMetricsRes.json()) as {
    ingested?: number;
    partialSuccess?: { rejectedDataPoints?: string; errorMessage?: string };
  };
  if (
    otlpMetricsRes.status !== 200 ||
    otlpMetricsReply.ingested !== 6 ||
    otlpMetricsReply.partialSuccess?.rejectedDataPoints !== "1" ||
    !otlpMetricsReply.partialSuccess.errorMessage?.includes("does not say its temporality")
  ) {
    throw new Error(`OTLP metrics ingest: ${otlpMetricsRes.status} ${JSON.stringify(otlpMetricsReply)}`);
  }
  const otlpMetricsProtoRes = await fetch(`${APP_URL}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${INGEST_TOKEN}` },
    body: Buffer.from(
      encodeOtlpMetricsProtobuf({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  { name: `e2e.proto.p${otlpMetricRun}`, gauge: { dataPoints: [{ timeUnixNano: otlpNano, asDouble: 1 }] } },
                ],
              },
            ],
          },
        ],
      }),
    ),
  });
  if (
    otlpMetricsProtoRes.status !== 200 ||
    otlpMetricsProtoRes.headers.get("content-type") !== "application/x-protobuf" ||
    (await otlpMetricsProtoRes.arrayBuffer()).byteLength !== 0
  ) {
    throw new Error(`OTLP metrics protobuf ingest: ${otlpMetricsProtoRes.status}`);
  }
  // A running total from a series that started just now: 99, then 104, is 99 and then 5.
  const otlpTotal = `e2e.total.t${otlpMetricRun}`;
  const otlpTotalStart = String(Date.now() * 1_000_000);
  for (const [value, wantIngested] of [
    ["99", 1],
    ["104", 1],
    ["104", 0],
  ] as const) {
    const res = await fetch(`${APP_URL}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: otlpTotal,
                    sum: {
                      aggregationTemporality: 2,
                      isMonotonic: true,
                      dataPoints: [
                        {
                          startTimeUnixNano: otlpTotalStart,
                          timeUnixNano: String(Date.now() * 1_000_000),
                          asInt: value,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const reply = (await res.json()) as { ingested?: number; partialSuccess?: unknown };
    if (res.status !== 200 || reply.ingested !== wantIngested || reply.partialSuccess !== undefined) {
      throw new Error(`running total ${value}: ${res.status} ${JSON.stringify(reply)}`);
    }
    await Bun.sleep(5);
  }
  for (const [name, want] of [
    [otlpCounter, 12],
    [otlpGauge, 15],
    [otlpTotal, 104],
  ] as const) {
    const res = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", events: "0", metric: name }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    const body = (await res.json()) as { agg?: { stat: number | null; buckets: Array<{ v: number }> } };
    // The running total's two amounts can fall either side of a bar's edge; the window's sum cannot.
    const inOneBar = name === otlpTotal || body.agg?.buckets.some((bucket) => bucket.v === want);
    if (body.agg?.stat !== want || !inOneBar) {
      throw new Error(`expected ${name} to read ${want}, got ${JSON.stringify(body.agg)}`);
    }
  }

  // A histogram is read one way at a time. An older link's `.count` is its count.
  for (const [metric, reading, want] of [
    [`p50:${otlpHistogram}`, "p50", 100],
    [`p99:${otlpHistogram}`, "p99", 380],
    [otlpHistogram, "p99", 380],
    [`avg:${otlpHistogram}`, "avg", 140],
    [`${otlpHistogram}.count`, "count", 100],
  ] as const) {
    const res = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", events: "0", metric }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    const body = (await res.json()) as {
      agg?: { stat: number | null; kind?: string; reading?: string; metric?: string };
    };
    const agg = body.agg;
    if (
      agg?.kind !== "histogram" ||
      agg.reading !== reading ||
      agg.metric !== otlpHistogram ||
      Math.abs((agg.stat ?? Number.NaN) - want) > 1e-6
    ) {
      throw new Error(`expected ${metric} to read ${want} as ${reading}, got ${JSON.stringify(agg)}`);
    }
  }
  // A heatmap (#238): every bucket on the clock, with the p99 as its line and stat.
  const heatRes = await fetch(
    `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", events: "0", metric: `heatmap:${otlpHistogram}` }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  const heatAgg = ((await heatRes.json()) as { agg?: { stat: number | null; reading?: string; heat?: { le: Array<number | null>; cells: Array<{ n: number[] }> } } }).agg;
  if (
    heatAgg?.reading !== "heatmap" ||
    Math.abs((heatAgg.stat ?? Number.NaN) - 380) > 1e-6 ||
    JSON.stringify(heatAgg.heat?.le.slice(0, 3)) !== "[100,200,400]" ||
    (heatAgg.heat?.cells.flatMap((c) => c.n).reduce((a, b) => a + b, 0) ?? 0) !== 100
  ) {
    throw new Error(`a histogram read as a heatmap should carry its bounds and every count, got ${JSON.stringify(heatAgg)}`);
  }
  const otlpNamesRes = await fetch(
    `${APP_URL}/api/metric-names?${new URLSearchParams({ range: "15m", find: `h${otlpMetricRun}` }).toString()}`,
    { headers: { authorization: basicAuth() } },
  );
  const otlpNames = (await otlpNamesRes.json()) as { keys: Array<{ k: string; kind: string }> };
  if (otlpNames.keys.length !== 1 || otlpNames.keys[0]?.k !== otlpHistogram || otlpNames.keys[0].kind !== "histogram") {
    throw new Error(`expected the histogram listed once, got ${JSON.stringify(otlpNames.keys)}`);
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
  // A protobuf request is answered in protobuf, and a full success is an empty message.
  const otlpProtoReply = new Uint8Array(await otlpProtoRes.arrayBuffer());
  if (
    otlpProtoRes.headers.get("content-type") !== "application/x-protobuf" ||
    otlpProtoReply.byteLength !== 0
  ) {
    throw new Error(
      `expected an empty protobuf reply, got ${otlpProtoRes.headers.get("content-type")} with ${otlpProtoReply.byteLength} bytes`,
    );
  }

  // One bodiless record in a batch: the rest are stored and the reply counts it, in the request's encoding.
  const partialBatch = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }] },
        scopeLogs: [
          {
            logRecords: [
              { severityText: "INFO", body: { stringValue: `${otlpProtoMarker} partial one` } },
              { severityText: "INFO" },
              { severityText: "INFO", body: { stringValue: `${otlpProtoMarker} partial two` } },
            ],
          },
        ],
      },
    ],
  };
  const partialJsonRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify(partialBatch),
  });
  const partialJson = (await partialJsonRes.json()) as {
    ingested?: number;
    partialSuccess?: { rejectedLogRecords?: string; errorMessage?: string };
  };
  if (
    partialJsonRes.status !== 200 ||
    partialJson.ingested !== 2 ||
    partialJson.partialSuccess?.rejectedLogRecords !== "1" ||
    !partialJson.partialSuccess.errorMessage?.includes("no body")
  ) {
    throw new Error(`expected a JSON partial success, got ${partialJsonRes.status} ${JSON.stringify(partialJson)}`);
  }
  const partialProtoRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${INGEST_TOKEN}` },
    body: Buffer.from(encodeOtlpProtobuf(partialBatch)),
  });
  const partialProto = decodeOtlpReply(new Uint8Array(await partialProtoRes.arrayBuffer()));
  if (
    partialProtoRes.status !== 200 ||
    partialProtoRes.headers.get("content-type") !== "application/x-protobuf" ||
    partialProto.rejected !== 1 ||
    !partialProto.errorMessage.includes("no body")
  ) {
    throw new Error(`expected a protobuf partial success, got ${partialProtoRes.status} ${JSON.stringify(partialProto)}`);
  }

  // OTLP over gRPC: the same request as one call, on the second port, with the token as metadata.
  const grpcPort = Number(envValue("OTLP_GRPC_PORT") ?? "4319");
  if (grpcPort > 0) {
    const grpcHost = new URL(APP_URL).hostname;
    const grpcMarker = `grpc${Date.now()}`;
    // Asked first over plain TCP: nothing listening is a clearer failure than a client error.
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(grpcPort, grpcHost);
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", () =>
        reject(new Error(`OTLP gRPC is not listening on ${grpcHost}:${grpcPort}; set OTLP_GRPC_PORT (0 skips this)`)),
      );
    });
    const grpcCall = (authorization: string | null) =>
      new Promise<{ status: string | undefined; reply: number }>((resolve, reject) => {
        const session = http2.connect(`http://${grpcHost}:${grpcPort}`);
        session.on("error", reject);
        const call = session.request({
          ":method": "POST",
          ":path": "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
          "content-type": "application/grpc",
          te: "trailers",
          ...(authorization ? { authorization } : {}),
        });
        let head: Record<string, unknown> = {};
        let trailers: Record<string, unknown> = {};
        let reply = 0;
        call.on("response", (h) => (head = h));
        call.on("trailers", (t) => (trailers = t));
        call.on("data", (chunk: Buffer) => (reply += chunk.length));
        call.on("error", reject);
        call.on("end", () => {
          session.close();
          const status = trailers["grpc-status"] ?? head["grpc-status"];
          resolve({ status: status === undefined ? undefined : String(status), reply });
        });
        call.end(
          grpcFrame(
            encodeOtlpProtobuf({
              resourceLogs: [
                {
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }] },
                  scopeLogs: [{ logRecords: [{ severityText: "INFO", body: { stringValue: `over grpc ${grpcMarker}` } }] }],
                },
              ],
            }),
          ),
        );
      });
    const grpcNoToken = await grpcCall(null);
    if (grpcNoToken.status !== "16") {
      throw new Error(`expected a gRPC call with no token to be UNAUTHENTICATED (16), got ${grpcNoToken.status}`);
    }
    const grpcSent = await grpcCall(`Bearer ${INGEST_TOKEN}`);
    // OK, and an empty reply: its five-byte prefix and nothing after it.
    if (grpcSent.status !== "0" || grpcSent.reply !== 5) {
      throw new Error(`expected a gRPC export to be OK with an empty reply, got ${JSON.stringify(grpcSent)}`);
    }
    const grpcFound = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q: `service:otlp-e2e ${grpcMarker}` }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    const grpcRows = (await grpcFound.json()) as { total: number };
    if (grpcRows.total !== 1) {
      throw new Error(`expected the row sent over gRPC once, got ${grpcRows.total}`);
    }
  }

  // A map body is kept: found by a word in its message, filterable by one of its top-level fields.
  const mapBodyMarker = `mapbody${Date.now()}`;
  const mapBodyRes = await fetch(`${APP_URL}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "otlp-e2e" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: {
                    kvlistValue: {
                      values: [
                        { key: "message", value: { stringValue: `charge failed ${mapBodyMarker}` } },
                        { key: "order_ref", value: { stringValue: mapBodyMarker } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (!mapBodyRes.ok) {
    throw new Error(`map body ingest failed: ${mapBodyRes.status} ${await mapBodyRes.text()}`);
  }
  for (const q of [mapBodyMarker, `order_ref:${mapBodyMarker}`]) {
    const found = await fetch(
      `${APP_URL}/api/search?${new URLSearchParams({ range: "15m", q }).toString()}`,
      { headers: { authorization: basicAuth() } },
    );
    const body = (await found.json()) as { events?: Array<{ message: string }> };
    if (body.events?.[0]?.message !== `charge failed ${mapBodyMarker}`) {
      throw new Error(`expected the map-body row for q=${q}, got ${JSON.stringify(body.events?.slice(0, 1))}`);
    }
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

  // An OpenTelemetry exporter batches 512 records by default; a full batch is stored.
  const otlpBatchService = `e2ebatch${Date.now()}`;
  const otlpBatchTs = new Date().toISOString();
  const otlpLogBatch = (count: number) =>
    fetch(`${APP_URL}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(
        toOtlpJson(
          Array.from({ length: count }, (_, i) => ({
            ts: otlpBatchTs,
            service: otlpBatchService,
            level: "info" as const,
            message: `batch line ${i}`,
          })),
        ),
      ),
    });
  const otlpBatchRes = await otlpLogBatch(512);
  const otlpBatchJson = (await otlpBatchRes.json()) as { ingested?: number };
  if (otlpBatchRes.status !== 200 || otlpBatchJson.ingested !== 512) {
    throw new Error(
      `expected a 512-record OTLP log batch to be stored, got ${otlpBatchRes.status} ${JSON.stringify(otlpBatchJson)}`,
    );
  }
  const otlpBatchSearch = await fetch(
    `${APP_URL}/api/search?q=${encodeURIComponent(`service:${otlpBatchService}`)}&range=15m&events=0`,
    { headers: { authorization: basicAuth() } },
  );
  const otlpBatchTotal = ((await otlpBatchSearch.json()) as { total?: number }).total;
  if (otlpBatchTotal !== 512) {
    throw new Error(`expected 512 stored OTLP log records, search total is ${otlpBatchTotal}`);
  }
  const overflowLogs = await otlpLogBatch(1025);
  if (overflowLogs.status !== 400) {
    throw new Error(`expected 400 for 1025 OTLP log records, got ${overflowLogs.status}`);
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
  // The cron runs in this process: with an address, the body links back (#108).
  const publicBefore = process.env.TOPOSCOPE_PUBLIC_URL;
  process.env.TOPOSCOPE_PUBLIC_URL = "https://toposcope.e2e.test/logs/";
  try {
    await evaluateAlerts();
  } finally {
    if (publicBefore === undefined) {
      delete process.env.TOPOSCOPE_PUBLIC_URL;
    } else {
      process.env.TOPOSCOPE_PUBLIC_URL = publicBefore;
    }
  }
  if (received.length < 1) {
    hook.stop();
    throw new Error("expected p99 alert to fire a webhook");
  }
  const fired = received.find((row) => {
    if (!row || typeof row !== "object") {
      return false;
    }
    return (row as { agg?: string | null }).agg === "p99:duration_ms";
  }) as { agg?: string | null; value?: number; count?: number; link?: string } | undefined;
  if (!fired || typeof fired.value !== "number") {
    hook.stop();
    throw new Error(`webhook missing agg/value: ${JSON.stringify(received)}`);
  }
  const firedLink = fired.link ? new URL(fired.link) : null;
  if (
    !firedLink ||
    `${firedLink.origin}${firedLink.pathname}` !== "https://toposcope.e2e.test/logs/" ||
    firedLink.searchParams.get("saved") !== p99Saved.id ||
    firedLink.searchParams.get("agg") !== "p99:duration_ms" ||
    firedLink.searchParams.get("range") !== "custom" ||
    !firedLink.searchParams.get("from") ||
    !firedLink.searchParams.get("to")
  ) {
    hook.stop();
    throw new Error(`webhook link should open the saved search over the window that fired, got ${fired.link}`);
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

  // #107: an alert on a fingerprint first seen after a deploy.
  {
    const svc = `e2efs${marker}`;
    const nowMs = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const post = (path: string, body: unknown) =>
      fetch(`${APP_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
        body: JSON.stringify(body),
      });
    const fsMarkId = `mk_${svc}`;
    const otherMarkId = `mk_${svc}_other`;
    for (const [id, service] of [[fsMarkId, svc], [otherMarkId, `${svc}-other`]] as const) {
      const res = await post("/v1/marks", { id, kind: "deploy", title: "v0.9.3", service, ts: iso(nowMs - 2 * 60_000) });
      if (!res.ok) throw new Error(`first-seen mark failed: ${res.status} ${await res.text()}`);
    }
    const oldMessage = `${svc} known error before the deploy`;
    const newMessage = `${svc} TypeError after the deploy`;
    const ev = (ts: number, message: string) => ({ ts: iso(ts), level: "error", service: svc, host: "e2e-1", message });
    const ingest = await post("/api/ingest", [
      ev(nowMs - 30 * 60_000, oldMessage),
      ev(nowMs - 60_000, oldMessage),
      ev(nowMs - 60_000, newMessage),
    ]);
    if (!ingest.ok) throw new Error(`first-seen ingest failed: ${ingest.status}`);
    const newE1 = withFingerprint("error", newMessage, {})?.e1 as string | undefined;
    const oldE1 = withFingerprint("error", oldMessage, {})?.e1 as string | undefined;
    const fsSavedRes = await fetch(`${APP_URL}/api/saved-searches`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basicAuth() },
      body: JSON.stringify({ name: `e2e first seen ${marker}`, query: `service:${svc} level:error`, range: "1h" }),
    });
    if (!fsSavedRes.ok) throw new Error(`first-seen save failed: ${fsSavedRes.status}`);
    const fsSaved = (await fsSavedRes.json()) as { id: string };
    const fsReceived: Array<{ mark?: { id: string }; fingerprints?: Array<{ e1: string; events: number }>; link?: string }> = [];
    const fsHook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        fsReceived.push((await req.json()) as (typeof fsReceived)[number]);
        return new Response("ok");
      },
    });
    try {
      const badKind = await fetch(`${APP_URL}/api/alert-rules`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify({ name: "x", kind: "first_seen", saved_search_id: fsSaved.id, threshold: 0.5, webhook_url: `http://127.0.0.1:${fsHook.port}/hook` }),
      });
      if (badKind.status !== 400) throw new Error(`first-seen threshold 0.5 expected 400, got ${badKind.status}`);
      const fsRuleRes = await fetch(`${APP_URL}/api/alert-rules`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify({ name: `e2e new bugs ${marker}`, kind: "first_seen", saved_search_id: fsSaved.id, threshold: 1, webhook_url: `http://127.0.0.1:${fsHook.port}/hook` }),
      });
      if (!fsRuleRes.ok) throw new Error(`first-seen alert failed: ${fsRuleRes.status} ${await fsRuleRes.text()}`);
      const fsRule = (await fsRuleRes.json()) as { id: string; kind: string };
      if (fsRule.kind !== "first_seen") throw new Error(`first-seen alert kind, got ${fsRule.kind}`);
      let ours = fsReceived.filter((b) => b.mark?.id === fsMarkId);
      for (let i = 0; i < 20 && ours.length === 0; i++) {
        await evaluateAlerts();
        ours = fsReceived.filter((b) => b.mark?.id === fsMarkId);
        if (ours.length === 0) await Bun.sleep(250);
      }
      if (ours.length !== 1) throw new Error(`expected one first-seen call for the deploy, got ${JSON.stringify(fsReceived)}`);
      const listed = ours[0]!.fingerprints?.map((f) => f.e1) ?? [];
      if (!newE1 || !listed.includes(newE1)) throw new Error(`first-seen call should name ${newE1}, got ${JSON.stringify(ours[0])}`);
      if (oldE1 && listed.includes(oldE1)) throw new Error("an e1 seen in the hour before the deploy must not page");
      if (fsReceived.some((b) => b.mark?.id === otherMarkId)) throw new Error("a mark whose service the q rules out must not page");
      await evaluateAlerts();
      if (fsReceived.filter((b) => b.mark?.id === fsMarkId).length !== 1) throw new Error("the same e1 must not page again the next minute");
      const listRes = await fetch(`${APP_URL}/api/alert-rules`, { headers: { authorization: basicAuth() } });
      const listed2 = (await listRes.json()) as { rules: Array<{ id: string; last_mark: { id: string; count: number } | null }> };
      const stored = listed2.rules.find((r) => r.id === fsRule.id);
      if (stored?.last_mark?.id !== fsMarkId || stored.last_mark.count < 1) throw new Error(`first-seen alert should record the mark it paged on, got ${JSON.stringify(stored)}`);
      const del = await fetch(`${APP_URL}/api/alert-rules/${fsRule.id}`, { method: "DELETE", headers: { authorization: basicAuth() } });
      if (!del.ok) throw new Error(`delete first-seen alert failed: ${del.status}`);
    } finally {
      fsHook.stop();
    }
    const fsSavedDel = await fetch(`${APP_URL}/api/saved-searches/${fsSaved.id}`, { method: "DELETE", headers: { authorization: basicAuth() } });
    if (!fsSavedDel.ok) throw new Error(`delete first-seen search failed: ${fsSavedDel.status}`);
  }

  // #108: an alert's body of its own, a test call, and a body that does not parse.
  {
    const bodyQuery = 'service:e2e -"no such row"';
    const bodySavedRes = await fetch(`${APP_URL}/api/saved-searches`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basicAuth() },
      body: JSON.stringify({ name: `e2e body ${marker}`, query: bodyQuery, range: "1h" }),
    });
    if (!bodySavedRes.ok) throw new Error(`body save failed: ${bodySavedRes.status}`);
    const bodySaved = (await bodySavedRes.json()) as { id: string };
    const got: Array<{ path: string; type: string; body: string }> = [];
    const stand = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        const body = await req.text();
        got.push({ path, type: req.headers.get("content-type") ?? "", body });
        if (path === "/1/messages.json") {
          const json = JSON.parse(body) as Record<string, unknown>;
          const ok = ["token", "user", "message"].every((k) => typeof json[k] === "string" && json[k]);
          return ok ? Response.json({ status: 1, request: "e2e" }) : Response.json({ status: 0, errors: ["user is missing"] }, { status: 400 });
        }
        return new Response("ok");
      },
    });
    try {
      const pushover = {
        name: `e2e pushover ${marker}`,
        kind: "threshold",
        saved_search_id: bodySaved.id,
        threshold: 1,
        webhook_url: `http://127.0.0.1:${stand.port}/1/messages.json`,
        body_kind: "json",
        body_template: '{"token": "app", "user": "me", "message": "{{alert.name}}: {{value}} for {{query}}"}',
      };
      const tc = await fetch(`${APP_URL}/api/alert-rules/test-call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify(pushover),
      });
      const tcBody = (await tc.json()) as { ok?: boolean; status?: number; reply?: string; sent?: string; error?: string };
      if (!tc.ok || !tcBody.ok || tcBody.status !== 200 || tcBody.reply !== '{"status":1,"request":"e2e"}') {
        throw new Error(`test call to the Pushover stand-in should be accepted, got ${tc.status} ${JSON.stringify(tcBody)}`);
      }
      const sentMessage = (JSON.parse(tcBody.sent ?? "{}") as { message?: string }).message ?? "";
      if (!sentMessage.endsWith(`for ${bodyQuery}`)) throw new Error(`a q with quotes should be escaped into the JSON body, got ${tcBody.sent}`);
      // #175 (18t): with a resolved body, the test sends that one after the open one.
      const both = await fetch(`${APP_URL}/api/alert-rules/test-call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify({ ...pushover, resolved_body: '{"token": "app", "user": "me", "message": "{{alert.name}} {{state}}"}' }),
      });
      const bothBody = (await both.json()) as { ok?: boolean; resolved?: { ok: boolean; sent: string } | null };
      if (!bothBody.ok || !bothBody.resolved?.ok || JSON.parse(bothBody.resolved.sent).message !== `${pushover.name} resolved`) {
        throw new Error(`a test with a resolved body should send both, got ${JSON.stringify(bothBody)}`);
      }
      const broken = await fetch(`${APP_URL}/api/alert-rules`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify({ ...pushover, body_template: '{\n  "token": "app",\n  "user": "me"\n  "message": "{{alert.name}}"\n}' }),
      });
      const brokenBody = (await broken.json()) as { error?: string };
      if (broken.status !== 400 || !brokenBody.error?.startsWith('Not JSON yet: line 4, column 3 — a , is missing after "me".')) {
        throw new Error(`a JSON body that does not parse should be refused with where, got ${broken.status} ${JSON.stringify(brokenBody)}`);
      }
      const textRuleRes = await fetch(`${APP_URL}/api/alert-rules`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth() },
        body: JSON.stringify({ ...pushover, name: `e2e ntfy ${marker}`, webhook_url: `http://127.0.0.1:${stand.port}/e2e-topic`, body_kind: "text", body_template: "{{alert.name}} fired: {{series}} {{value}} ≥ {{threshold}}" }),
      });
      if (!textRuleRes.ok) throw new Error(`text body alert failed: ${textRuleRes.status} ${await textRuleRes.text()}`);
      const textRule = (await textRuleRes.json()) as { id: string; body_kind: string };
      await evaluateAlerts();
      const toTopic = got.filter((g) => g.path === "/e2e-topic");
      if (toTopic.length !== 1 || !toTopic[0]!.type.startsWith("text/plain") || !/^e2e ntfy \S+ fired: Count \d+ ≥ 1$/.test(toTopic[0]!.body)) {
        throw new Error(`a text body should reach the topic as that text, got ${JSON.stringify(toTopic)}`);
      }
      await fetch(`${APP_URL}/api/alert-rules/${textRule.id}`, { method: "DELETE", headers: { authorization: basicAuth() } });
    } finally {
      stand.stop();
    }
    await fetch(`${APP_URL}/api/saved-searches/${bodySaved.id}`, { method: "DELETE", headers: { authorization: basicAuth() } });
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
  // Shares the value under another name: not a link (#110).
  const otherKey = `e2e_shelf_${marker.replaceAll("-", "_")}`;
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
          [otherKey]: hop,
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
        labels: { source: hop, [systemKey]: hop },
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
        catalog.suggestLinks[systemKey] === systemKey
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
    if (catalog.suggestLinks[systemKey] !== systemKey) {
      throw new Error(
        `expected ${systemKey} → ${systemKey} suggestion, got ${JSON.stringify(catalog.suggestLinks)}`,
      );
    }
    if (catalog.suggestLinks[otherKey]) {
      throw new Error(
        `a shared value under another name must not be suggested, got ${otherKey} → ${catalog.suggestLinks[otherKey]}`,
      );
    }
    if (catalog.links[systemKey]) {
      throw new Error("a suggestion must not write a link");
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

  // A feed (#135): defined with a q, read by arrival position after where the reader stood.
  const feedService = `${marker}-feed`;
  const badFeed = await fetch(`${APP_URL}/api/feeds`, {
    method: "POST",
    headers: { authorization: basicAuth(), "content-type": "application/json" },
    body: JSON.stringify({ q: 'level:error message:"unclosed' }),
  });
  if (badFeed.status !== 400) {
    throw new Error(`a feed with a bad q must be refused, got ${badFeed.status}`);
  }
  const feedRes = await fetch(`${APP_URL}/api/feeds`, {
    method: "POST",
    headers: { authorization: basicAuth(), "content-type": "application/json" },
    body: JSON.stringify({ q: `service:${feedService} level:error` }),
  });
  if (feedRes.status !== 201) {
    throw new Error(`feed create failed: ${feedRes.status} ${await feedRes.text()}`);
  }
  const feed = (await feedRes.json()) as { id: string };
  type FeedReply = { through: number; settled: number; rows: Array<{ message: string; seq: number }>; arrived: string | null };
  const readFeed = async (after: number): Promise<FeedReply> => {
    const res = await fetch(`${APP_URL}/api/feeds/${feed.id}?after=${after}&limit=100`, {
      headers: { authorization: basicAuth() },
    });
    if (!res.ok) {
      throw new Error(`feed read failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as FeedReply;
  };
  const stood = (await readFeed(0)).settled;
  const feedIngest = await fetch(`${APP_URL}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify([
      { service: feedService, level: "error", message: `${marker}-feed-1` },
      { service: feedService, level: "info", message: `${marker}-feed-info` },
      { service: feedService, level: "error", message: `${marker}-feed-2` },
    ]),
  });
  if (!feedIngest.ok) {
    throw new Error(`feed ingest failed: ${feedIngest.status} ${await feedIngest.text()}`);
  }
  const fed: string[] = [];
  let feedAt = stood;
  for (let i = 0; i < 50; i++) {
    const reply = await readFeed(feedAt);
    fed.push(...reply.rows.map((r) => r.message));
    if (reply.through === feedAt && feedAt >= reply.settled) {
      break;
    }
    feedAt = reply.through;
  }
  if (fed.join(",") !== `${marker}-feed-1,${marker}-feed-2`) {
    throw new Error(`feed must return exactly its two error rows in arrival order, got ${JSON.stringify(fed)}`);
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
  const followSpanParams = new URLSearchParams({
    q: `request_id:${followHex}`,
    at: new Date(followTs).toISOString(),
  }).toString();
  const followSpanAnon = await fetch(`${APP_URL}/api/search/follow-span?${followSpanParams}`);
  if (followSpanAnon.status !== 401) {
    throw new Error(`follow span without auth: expected 401, got ${followSpanAnon.status}`);
  }
  const followSpanRes = await fetch(`${APP_URL}/api/search/follow-span?${followSpanParams}`, {
    headers: { authorization: basicAuth() },
  });
  if (!followSpanRes.ok) {
    throw new Error(`follow span failed: ${followSpanRes.status} ${await followSpanRes.text()}`);
  }
  const followSpan = (await followSpanRes.json()) as {
    n: number | null;
    first: string | null;
    last: string | null;
  };
  if (
    followSpan.n !== 3 ||
    followSpan.first !== new Date(followTs - 1000).toISOString() ||
    followSpan.last !== new Date(followTs + 1000).toISOString()
  ) {
    throw new Error(`follow span must be the 3 hops' first and last row, got ${JSON.stringify(followSpan)}`);
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

  const spanBatch = (traceIdHex: string, count: number): Span[] =>
    Array.from({ length: count }, (_, i) => ({
      trace_id: traceIdHex,
      span_id: (i + 1).toString(16).padStart(16, "0"),
      parent_span_id: "",
      service: "overflow",
      name: "span",
      ts: treeTs,
      duration_ms: 1,
      status: "unset",
      attrs: {},
    }));
  const postSpans = (batch: Span[]) =>
    fetch(`${APP_URL}/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(toOtlpTracesJson(batch)),
    });

  // An OpenTelemetry exporter batches 512 spans by default; a full batch is stored.
  const batchTraceId = crypto.randomUUID().replaceAll("-", "");
  const spanBatchRes = await postSpans(spanBatch(batchTraceId, 512));
  const spanBatchJson = (await spanBatchRes.json()) as { ingested?: number };
  if (spanBatchRes.status !== 200 || spanBatchJson.ingested !== 512) {
    throw new Error(
      `expected a 512-span OTLP batch to be stored, got ${spanBatchRes.status} ${JSON.stringify(spanBatchJson)}`,
    );
  }
  const spanBatchGet = await fetch(`${APP_URL}/api/traces/${batchTraceId}`, {
    headers: { authorization: basicAuth() },
  });
  const spanBatchTotal = ((await spanBatchGet.json()) as { total?: number }).total;
  if (spanBatchTotal !== 512) {
    throw new Error(`expected 512 stored spans, trace total is ${spanBatchTotal}`);
  }

  const overflowRes = await postSpans(spanBatch("f".repeat(32), 1025));
  if (overflowRes.status !== 400) {
    throw new Error(`expected 400 for 1025 spans, got ${overflowRes.status}`);
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
        Array.from({ length: 1025 }, (_, i) => ({
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
    throw new Error(`expected 400 for 1025 profiles, got ${overflowProfiles.status}`);
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

  // #102: a browser with no Basic prompt signs in on a page; scripts keep Basic.
  {
    const page = await fetch(`${APP_URL}/`, { headers: { accept: "text/html" } });
    const pageText = await page.text();
    if (page.status !== 401 || page.headers.get("www-authenticate") || !pageText.includes("Signing in to")) {
      throw new Error(`a page without the password should be the sign-in page, got ${page.status} ${page.headers.get("www-authenticate")}`);
    }
    const bare = await fetch(`${APP_URL}/api/saved-searches`);
    if (bare.status !== 401 || !bare.headers.get("www-authenticate")?.startsWith('Basic realm="toposcope')) {
      throw new Error(`an API call without credentials should keep the Basic challenge, got ${bare.status}`);
    }
    const wrong = await fetch(`${APP_URL}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: `${PASSWORD}-not` }) });
    if (wrong.status !== 401) throw new Error(`a wrong password should be refused, got ${wrong.status}`);
    const right = await fetch(`${APP_URL}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const setCookie = right.headers.get("set-cookie") ?? "";
    if (!right.ok || !/HttpOnly; SameSite=Strict/.test(setCookie)) throw new Error(`sign-in should set a cookie, got ${right.status} ${setCookie}`);
    const cookie = setCookie.split(";")[0]!;
    const withCookie = await fetch(`${APP_URL}/api/instance`, { headers: { cookie } });
    const info = (await withCookie.json()) as { session?: { kind: string } };
    if (!withCookie.ok || info.session?.kind !== "cookie") throw new Error(`the cookie should sign the browser in, got ${withCookie.status} ${JSON.stringify(info)}`);
    await fetch(`${APP_URL}/api/sign-out`, { method: "POST", headers: { cookie } });
    const after = await fetch(`${APP_URL}/api/saved-searches`, { headers: { cookie } });
    if (after.status !== 401 || after.headers.get("www-authenticate")) throw new Error(`after Sign out the cookie should be refused without the challenge, got ${after.status}`);
  }

  // #177: a script, a cron job or a box tells Toposcope how it went. A first result creates its
  // push monitor; past every it is late and past every + grace it opens (the pass runs here with
  // a clock it is handed); a fail opens, a warn does not, Nagios's 3 changes nothing; the keyed
  // URL's /fail opens; results are rows in Search; 501 results and an unknown key are refused.
  {
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    const bearer = { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` };
    const pushName = `e2e-push-${marker}`;
    const nagiosName = `e2e-nagios-${marker}`;
    const probeName = `e2e_probe_${marker}`;
    const calls: Array<Record<string, unknown>> = [];
    const pushHook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push((await req.json()) as Record<string, unknown>);
        return new Response("ok");
      },
    });
    const settingsBefore = (await (await fetch(`${APP_URL}/api/settings`, { headers: auth })).json()) as {
      default_webhook_url?: string | null;
    };
    const check = (body: unknown) => fetch(`${APP_URL}/v1/checks`, { method: "POST", headers: bearer, body: JSON.stringify(body) });
    type PushPage = {
      id: string;
      state: string;
      source: string;
      last_result: string | null;
      due_from: number;
      ping_key?: string;
      open: { due_at: number | null } | null;
    };
    const page = async (name: string) =>
      (await (await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(name)}`, { headers: auth })).json()) as PushPage;
    try {
      // A monitor its first result made calls the default webhook from Settings.
      const setDefault = await fetch(`${APP_URL}/api/settings`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ default_webhook_url: `http://127.0.0.1:${pushHook.port}/default` }),
      });
      if (!setDefault.ok) throw new Error(`setting the default webhook failed: ${setDefault.status}`);

      const first = await check({ monitor: pushName, status: "ok", message: "snapshot saved", every: "1h", grace: "15m", host: "e2e-box" });
      const firstBody = (await first.json()) as { ingested: number; created: string[] };
      if (!first.ok || JSON.stringify(firstBody.created) !== JSON.stringify([pushName])) {
        throw new Error(`a result for an unknown name should create its monitor, got ${first.status} ${JSON.stringify(firstBody)}`);
      }
      const made = await page(pushName);
      if (made.source !== "push" || made.state !== "ok" || !made.ping_key) throw new Error(`a push monitor should be made, got ${JSON.stringify(made)}`);
      const key = made.ping_key;
      const listText = await (await fetch(`${APP_URL}/api/monitors`, { headers: auth })).text();
      if (listText.includes(key)) throw new Error("the monitors list must not print a push monitor's key");

      // every 1h, grace 15m, nothing after: late at 1h, open at 1h15m.
      const t0 = made.due_from;
      await evaluateAlerts(t0 + 60 * 60_000 + 30_000);
      const late = await page(pushName);
      const callCount = () => calls.length;
      if (late.state !== "ok" || callCount() !== 0) throw new Error(`late is not open and calls nobody, got ${JSON.stringify(late)} ${JSON.stringify(calls)}`);
      await evaluateAlerts(t0 + 75 * 60_000);
      const missed = await page(pushName);
      if (missed.state !== "open" || missed.open?.due_at !== t0 + 60 * 60_000) {
        throw new Error(`past every + grace it should open, missed, got ${JSON.stringify(missed)}`);
      }
      if (callCount() !== 1 || calls[0]!.state !== "open" || (calls[0]!.alert as { source?: string }).source !== "push") {
        throw new Error(`a missed result should call the default webhook once, got ${JSON.stringify(calls)}`);
      }

      // The next ok resolves it; a warn shows and does not open.
      if (!(await check({ monitor: pushName, status: "ok" })).ok) throw new Error("ok result failed");
      // The resolve happened at the real time; its call goes out on a pass at that time (or the app's own).
      await evaluateAlerts(Date.now());
      if ((await page(pushName)).state !== "ok" || calls.at(-1)?.state !== "resolved") throw new Error(`an ok should resolve it, got ${JSON.stringify(calls)}`);
      if (!(await check({ monitor: pushName, status: "warn", message: "/var 87% used", value: 87.2, unit: "%" })).ok) throw new Error("warn result failed");
      const warned = await page(pushName);
      if (warned.state !== "ok" || warned.last_result !== "warn") throw new Error(`a warn shows and does not open, got ${JSON.stringify(warned)}`);

      // Nagios's 2 opens; 3 changes nothing.
      if (!(await check({ monitor: nagiosName, status: 2, message: "DISK CRITICAL" })).ok) throw new Error("nagios 2 failed");
      if ((await page(nagiosName)).state !== "open") throw new Error("exit code 2 should open");
      if (!(await check({ monitor: nagiosName, status: 3 })).ok) throw new Error("nagios 3 failed");
      const unknown = await page(nagiosName);
      if (unknown.state !== "open" || unknown.last_result !== "fail") throw new Error(`3 should change nothing, got ${JSON.stringify(unknown)}`);

      // The keyed URL's /fail opens, with no token; an unknown key gets 404 and writes nothing.
      const fail = await fetch(`${APP_URL}/ping/${key}/fail`, { method: "POST", body: "unable to create lock" });
      if (fail.status !== 200 || (await fail.text()) !== "OK\n") throw new Error(`/ping/<key>/fail should answer OK, got ${fail.status}`);
      if ((await page(pushName)).state !== "open") throw new Error("the keyed URL's /fail should open it");
      const stranger = await fetch(`${APP_URL}/ping/${crypto.randomUUID()}/fail`, { method: "POST", body: `stranger-${marker}` });
      if (stranger.status !== 404) throw new Error(`an unknown key should get 404, got ${stranger.status}`);
      const again = await fetch(`${APP_URL}/ping/${key}/fail`);
      if (again.status !== 429) throw new Error(`a second result within a second should get 429, got ${again.status}`);

      // An attached probe is a result too.
      const probe = await fetch(`${APP_URL}/v1/probes`, { method: "POST", headers: bearer, body: JSON.stringify({ service: "e2e", up: 0, check: probeName }) });
      if (!probe.ok || (await page(probeName)).state !== "open") throw new Error("an attached probe should be read as a fail");

      // 501 results are refused.
      const tooMany = await check(Array.from({ length: 501 }, (_, i) => ({ monitor: `${pushName}-${i}`, status: "ok" })));
      if (tooMany.status !== 400) throw new Error(`a batch of 501 should be refused, got ${tooMany.status}`);

      // Every result is a row: monitor:<name> finds them, and nothing the unknown key sent.
      const rows = async (q: string) =>
        (
          (await (
            await fetch(`${APP_URL}/api/search?${new URLSearchParams({ q, range: "15m" }).toString()}`, { headers: auth })
          ).json()) as { total: number; events: Array<{ message: string; level: string; attrs: Record<string, string> }> }
        );
      let found = await rows(`monitor:${pushName}`);
      for (let i = 0; i < 40 && found.total < 4; i++) {
        await Bun.sleep(250);
        found = await rows(`monitor:${pushName}`);
      }
      const failRow = found.events.find((e) => e.message === "unable to create lock");
      if (found.total !== 4 || failRow?.level !== "error" || failRow.attrs.status !== "fail" || failRow.attrs.source !== "push") {
        throw new Error(`results should be rows found by monitor:<name>, got ${JSON.stringify(found.events)}`);
      }
      if ((await rows(`stranger-${marker}`)).total !== 0) throw new Error("an unknown key should write nothing");
      if ((await rows(`monitor:${nagiosName} status:unknown`)).total !== 1) throw new Error("an unknown result is still a row");
    } finally {
      pushHook.stop();
      for (const n of [pushName, nagiosName, probeName]) {
        await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { method: "DELETE", headers: auth });
      }
      await fetch(`${APP_URL}/api/settings`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ default_webhook_url: settingsBefore.default_webhook_url ?? "" }),
      });
    }
  }

  // #179: who watches Toposcope. After each pass the loop checks in at TOPOSCOPE_WATCHDOG_URL,
  // or at <url>/fail when ClickHouse does not answer; unset, it calls nothing.
  {
    const checkIns: string[] = [];
    const stand = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        checkIns.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("OK");
      },
    });
    const before = { url: process.env.TOPOSCOPE_WATCHDOG_URL, ch: process.env.CLICKHOUSE_URL };
    try {
      delete process.env.TOPOSCOPE_WATCHDOG_URL;
      if ((await monitorTick()) !== "ok" || checkIns.length !== 0) throw new Error(`unset, the watchdog calls nothing, got ${JSON.stringify(checkIns)}`);
      process.env.TOPOSCOPE_WATCHDOG_URL = `http://127.0.0.1:${stand.port}/hc/e2e${marker}`;
      await monitorTick();
      await monitorTick();
      if (JSON.stringify(checkIns) !== JSON.stringify([`GET /hc/e2e${marker}`, `GET /hc/e2e${marker}`])) {
        throw new Error(`each pass should check in, got ${JSON.stringify(checkIns)}`);
      }
      // ClickHouse stops answering: nothing listens on port 9.
      process.env.CLICKHOUSE_URL = "http://127.0.0.1:9";
      if ((await monitorTick()) !== "fail" || checkIns.at(-1) !== `GET /hc/e2e${marker}/fail`) {
        throw new Error(`with ClickHouse down the pass should check in at /fail, got ${JSON.stringify(checkIns)}`);
      }
    } finally {
      if (before.url === undefined) delete process.env.TOPOSCOPE_WATCHDOG_URL;
      else process.env.TOPOSCOPE_WATCHDOG_URL = before.url;
      if (before.ch === undefined) delete process.env.CLICKHOUSE_URL;
      else process.env.CLICKHOUSE_URL = before.ch;
      stand.stop();
    }
  }

  // #175, last: it waits minutes for its rows to age out of a 15m window, and the tests above
  // read a window that ends a minute after this run began.
  // A search monitor opens once, reminds on its schedule and sends one resolved call when its
  // series falls back; a silenced one keeps the record and calls nobody. The pass runs in this
  // process with a clock it is handed; the series is read from ClickHouse at the real time.
  {
    const svc = `e2emon${marker}`;
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    // Rows 14m45s old: in a 15m window now, out of it within a few minutes.
    const rowTs = new Date(Date.now() - (14 * 60 + 45) * 1000).toISOString();
    const monIngest = await fetch(`${APP_URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify([1, 2, 3].map((n) => ({ ts: rowTs, level: "error", service: svc, host: "e2e-1", message: `${svc} row ${n}` }))),
    });
    if (!monIngest.ok) throw new Error(`monitor ingest failed: ${monIngest.status}`);
    const monSavedRes = await fetch(`${APP_URL}/api/saved-searches`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: `e2e monitor ${marker}`, query: `service:${svc}`, range: "15m" }),
    });
    if (!monSavedRes.ok) throw new Error(`monitor search save failed: ${monSavedRes.status}`);
    const monSaved = (await monSavedRes.json()) as { id: string };
    const reading = async (): Promise<number> => {
      const res = await fetch(`${APP_URL}/api/saved-searches/${monSaved.id}/test`, { method: "POST", headers: auth });
      return ((await res.json()) as { count: number }).count;
    };
    for (let i = 0; i < 30 && (await reading()) < 3; i++) await Bun.sleep(250);
    if ((await reading()) < 3) throw new Error("monitor rows are not searchable");

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const monHook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push({ path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> });
        return new Response("ok");
      },
    });
    const name = `e2e loud ${marker}`;
    const quietName = `e2e silenced ${marker}`;
    try {
      const declare = async (n: string, path: string) =>
        fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ source: "search", saved_search_id: monSaved.id, threshold: 1, webhook_url: `http://127.0.0.1:${monHook.port}${path}`, remind_every: "window" }),
        });
      const made = await declare(name, "/loud");
      if (made.status !== 201) throw new Error(`PUT /api/monitors should create, got ${made.status} ${await made.text()}`);
      const quiet = (await (await declare(quietName, "/quiet")).json()) as { id: string };
      const silenceRes = await fetch(`${APP_URL}/api/alert-rules/${quiet.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ silence_for: "24h" }) });
      if (!silenceRes.ok) throw new Error(`silence a monitor failed: ${silenceRes.status}`);
      const states = (await (await declare(name, "/loud")).json()) as { id: string; remind_every: string };
      if (states.remind_every !== "window") throw new Error(`PUT again should replace, got ${JSON.stringify(states)}`);
      const ours = () => calls.filter((c) => c.path === "/loud").map((c) => c.body.state);
      const t0 = Date.now();
      await evaluateAlerts(t0);
      await evaluateAlerts(t0 + 60_000);
      if (JSON.stringify(ours()) !== '["open"]') throw new Error(`a monitor should open once, got ${JSON.stringify(ours())}`);
      const listed = (await (await fetch(`${APP_URL}/api/monitors`, { headers: auth })).json()) as {
        monitors: Array<{ name: string; state: string; open: { opened_at: number; calls: Array<{ what: string; status: string }> } | null }>;
      };
      const loud = listed.monitors.find((m) => m.name === name);
      // The app is another process: the state it reads is SQLite's, as after a restart. Its own
      // pass may have opened it a moment before this one did.
      const openedAt = loud?.open?.opened_at ?? 0;
      if (loud?.state !== "open" || openedAt > t0 || openedAt < t0 - 120_000 || loud.open?.calls[0]?.what !== "open" || loud.open.calls[0]?.status !== "200") {
        throw new Error(`the app should read the monitor open with its call, got ${JSON.stringify(loud)}`);
      }
      if (listed.monitors.find((m) => m.name === quietName)?.state !== "open") throw new Error("a silenced monitor still opens");
      await evaluateAlerts(t0 + 14 * 60_000);
      await evaluateAlerts(t0 + 15 * 60_000);
      if (JSON.stringify(ours()) !== '["open","reminder"]') throw new Error(`a monitor should remind once per window, got ${JSON.stringify(ours())}`);
      for (let i = 0; i < 90 && (await reading()) > 0; i++) await Bun.sleep(2000);
      if ((await reading()) !== 0) throw new Error("monitor rows did not leave the 15m window");
      await evaluateAlerts(t0 + 16 * 60_000);
      await evaluateAlerts(t0 + 17 * 60_000);
      const resolved = calls.filter((c) => c.path === "/loud").at(-1)?.body;
      // Resolved by this pass, or by the app's own a moment earlier: once either way.
      if (
        JSON.stringify(ours()) !== '["open","reminder","resolved"]' ||
        resolved?.opened_at !== new Date(openedAt).toISOString() ||
        typeof resolved?.resolved_at !== "string" ||
        Date.parse(resolved.resolved_at) <= openedAt
      ) {
        throw new Error(`a monitor should send one resolved call, got ${JSON.stringify(calls.filter((c) => c.path === "/loud"))}`);
      }
      if (calls.some((c) => c.path === "/quiet")) throw new Error(`a silenced monitor should call nobody, got ${JSON.stringify(calls)}`);
      const quietOne = (await (await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(quietName)}`, { headers: auth })).json()) as {
        state: string;
        stretches: Array<{ resolved_at: number | null; open_call: string; resolved_call: string; calls: Array<{ what: string; status: string }> }>;
      };
      const kept = quietOne.stretches[0];
      if (quietOne.state !== "ok" || !kept?.resolved_at || kept.open_call !== "silenced" || kept.resolved_call !== "silenced") {
        throw new Error(`a silenced monitor keeps its stretch, got ${JSON.stringify(quietOne)}`);
      }
      const rules = (await (await fetch(`${APP_URL}/api/alert-rules`, { headers: auth })).json()) as { rules: Array<{ name: string; last_fired_at: number | null }>; link: boolean };
      if (rules.rules.find((r) => r.name === name)?.last_fired_at !== Date.parse(resolved.resolved_at)) {
        throw new Error("/api/alert-rules should still say when it last fired");
      }
    } finally {
      monHook.stop();
      for (const n of [name, quietName]) {
        await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { method: "DELETE", headers: auth });
      }
      await fetch(`${APP_URL}/api/saved-searches/${monSaved.id}`, { method: "DELETE", headers: auth });
    }
  }

  // #176, after #175's block: a saved search that goes quiet. Fewer than 1 line in 15m opens
  // once the last line has left the window and resolves on the next; it stays shut while it can't
  // tell (Toposcope not up one whole window, a short linked source); p99 fewer than is refused.
  {
    const host = `e2equiet${marker}`;
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    const ingestLine = async (ts: string, n: number) => {
      const res = await fetch(`${APP_URL}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
        body: JSON.stringify([{ ts, level: "info", service: "ci-runner", host, message: `${host} line ${n}` }]),
      });
      if (!res.ok) throw new Error(`quiet ingest failed: ${res.status}`);
    };
    // The last line from the box, 14m45s old: in the 15m window now, out of it within seconds.
    const lastTs = new Date(Date.now() - (14 * 60 + 45) * 1000).toISOString();
    await ingestLine(lastTs, 1);
    const save = async (body: Record<string, unknown>) => {
      const res = await fetch(`${APP_URL}/api/saved-searches`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`quiet search save failed: ${res.status}`);
      return (await res.json()) as { id: string };
    };
    const lines = await save({ name: `e2e ci-box lines ${marker}`, query: `host:${host}`, range: "15m" });
    const never = await save({ name: `e2e never ${marker}`, query: `host:${host}-never`, range: "24h" });
    const slow = await save({ name: `e2e p99 ${marker}`, query: `host:${host}`, range: "15m", agg: "p99:duration_ms" });
    const reading = async (): Promise<{ count: number; last_line_at?: number | null }> => {
      const res = await fetch(`${APP_URL}/api/saved-searches/${lines.id}/test`, { method: "POST", headers: auth });
      return (await res.json()) as { count: number; last_line_at?: number | null };
    };
    for (let i = 0; i < 30 && (await reading()).count < 1; i++) await Bun.sleep(250);
    if ((await reading()).count !== 1) throw new Error("the box's line is not searchable");

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const hook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push({ path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> });
        return new Response("ok");
      },
    });
    const name = `e2e ci-box went quiet ${marker}`;
    const graceName = `e2e never talked ${marker}`;
    const heldBefore = cantTellHeld.links;
    try {
      const declare = (n: string, savedId: string, path: string, extra: Record<string, unknown> = {}) =>
        fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ source: "search", saved_search_id: savedId, opens_when: "fewer_than", threshold: 1, webhook_url: `http://127.0.0.1:${hook.port}${path}`, ...extra }),
        });
      const made = await declare(name, lines.id, "/quiet");
      if (made.status !== 201) throw new Error(`a fewer-than monitor should be declared, got ${made.status} ${await made.text()}`);
      const quiet = (await made.json()) as { id: string; opens_when: string };
      if (quiet.opens_when !== "fewer_than") throw new Error(`PUT should keep fewer_than, got ${JSON.stringify(quiet)}`);
      const p99 = await declare(`e2e p99 quiet ${marker}`, slow.id, "/p99", { threshold: 100 });
      const p99Body = (await p99.json()) as { error?: string };
      if (p99.status !== 400 || p99Body.error !== "fewer than reads a count or a rate; p99(duration_ms) over no lines has no value") {
        throw new Error(`p99 fewer than 100 should be refused with a reason, got ${p99.status} ${JSON.stringify(p99Body)}`);
      }

      const ours = () => calls.filter((c) => c.path === "/quiet").map((c) => c.body.state);
      const t0 = Date.now();
      // A clock this process is handed, an uptime of more than one window: the line is still in it.
      await evaluateAlerts(t0 + 16 * 60_000);
      if (getAlert(quiet.id)?.state !== "ok" || ours().length !== 0) throw new Error("a line in the window should keep it shut");
      for (let i = 0; i < 60 && (await reading()).count > 0; i++) await Bun.sleep(1000);
      if ((await reading()).count !== 0) throw new Error("the box's line did not leave the 15m window");

      // Linked source prod-us is behind and could feed host:<box>: the count is a floor.
      cantTellHeld.links = () => [
        {
          role: "pull",
          connects: "we",
          peer_name: "prod-us",
          q: "",
          position: 80,
          settled: 100,
          arrived_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          last_contact_at: Date.now() + 17 * 60_000,
          last_error: null,
          created_at: t0 - 86_400_000,
          gone_from: null,
          gone_to: null,
          gone_from_at: null,
          gone_to_at: null,
        },
      ];
      await evaluateAlerts(t0 + 17 * 60_000);
      const held = getAlert(quiet.id);
      // The app's own pass may have opened it a moment before, with its own clock and no links.
      if (ours().length === 0 && (held?.state !== "ok" || held.cant_tell?.kind !== "held" || held.cant_tell.sources[0]?.name !== "prod-us")) {
        throw new Error(`a short linked source should keep it shut and say so, got ${JSON.stringify(held)}`);
      }
      cantTellHeld.links = heldBefore;

      await evaluateAlerts(t0 + 18 * 60_000);
      if (JSON.stringify(ours()) !== '["open"]') throw new Error(`it should open once the last line is 15m old, got ${JSON.stringify(ours())}`);
      const opened = calls.find((c) => c.path === "/quiet")!.body as { value: number; alert: { opens_when?: string } };
      if (opened.value !== 0 || opened.alert.opens_when !== "fewer_than") throw new Error(`the open call should read 0, fewer than, got ${JSON.stringify(opened)}`);
      const listed = (await (await fetch(`${APP_URL}/api/monitors`, { headers: auth })).json()) as {
        monitors: Array<{ name: string; state: string; last_line_at?: number | null; open: { open_message: string } | null }>;
      };
      const watched = listed.monitors.find((m) => m.name === name);
      if (watched?.state !== "open" || watched.open?.open_message !== "no line for 15m" || watched.last_line_at !== Date.parse(lastTs)) {
        throw new Error(`Watch should read it open, no line for 15m, last line at ${lastTs}; got ${JSON.stringify(watched)}`);
      }

      // The next line resolves it.
      await ingestLine(new Date().toISOString(), 2);
      for (let i = 0; i < 30 && (await reading()).count < 1; i++) await Bun.sleep(250);
      await evaluateAlerts(t0 + 19 * 60_000);
      if (JSON.stringify(ours()) !== '["open","resolved"]') throw new Error(`the next line should resolve it once, got ${JSON.stringify(ours())}`);

      // Toposcope has not been up 24h: a search that never talked stays shut, and says why.
      const grace = (await (await declare(graceName, never.id, "/never")).json()) as { id: string };
      await evaluateAlerts(Date.now());
      const graceOne = (await (await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(graceName)}`, { headers: auth })).json()) as {
        state: string;
        cant_tell: { kind: string } | null;
        last_line_at?: number | null;
      };
      if (graceOne.state !== "ok" || graceOne.cant_tell?.kind !== "starting" || calls.some((c) => c.path === "/never")) {
        throw new Error(`a monitor should not open before one whole window of uptime, got ${JSON.stringify(graceOne)}`);
      }
      if (graceOne.last_line_at !== null) throw new Error(`a search that never matched reads no last line, got ${graceOne.last_line_at}`);
      void grace;
    } finally {
      cantTellHeld.links = heldBefore;
      hook.stop();
      for (const n of [name, graceName]) {
        await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { method: "DELETE", headers: auth });
      }
      for (const id of [lines.id, never.id, slow.id]) {
        await fetch(`${APP_URL}/api/saved-searches/${id}`, { method: "DELETE", headers: auth });
      }
    }
  }

  // #178, last (after #175's and #176's slow blocks): the app runs HTTP(S) monitors on its own
  // clock (every 30s at the least), so this waits about a minute for real runs against stand-ins
  // on spare ports. The
  // certificate check needs the app to trust the stand's CA: start it with
  // NODE_EXTRA_CA_CERTS=<dir>/ca.crt after `bun run scripts/http-stands.ts certs <dir>`, and
  // give this run TOPOSCOPE_E2E_CERTS=<dir>. Without them that one check reads the certificate
  // as not trusted, which must fail too.
  {
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    const certDir = envValue("TOPOSCOPE_E2E_CERTS");
    const certs = certDir ? readCerts(certDir) : makeCerts(20);
    const stands = startStands(certs, { slowMs: 600 });
    const calls: Array<{ path: string; state: unknown }> = [];
    const hook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push({ path: new URL(req.url).pathname, state: ((await req.json()) as { state?: unknown }).state });
        return new Response("ok");
      },
    });
    const hookUrl = (path: string) => `http://127.0.0.1:${hook.port}${path}`;
    const names = {
      flip: `e2e http flip ${marker}`,
      db: `e2e-http-db-${marker}`,
      slow: `e2e http slow ${marker}`,
      cert: `e2e http cert ${marker}`,
      redirect: `e2e http redirect ${marker}`,
    };
    type Http = {
      state: string;
      last_result: string | null;
      http: { fails_in_row: number; headers: string[]; last_run: { at: number; result: string; status: number | null; why: string | null; line: string | null } | null } | null;
      stretches?: Array<{ opened_at: number; resolved_at: number | null; closed_by: string | null }>;
    };
    const read = async (n: string) =>
      (await (await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { headers: auth })).json()) as Http;
    const until = async (what: string, n: string, ok: (m: Http) => boolean, ms = 75_000) => {
      const end = Date.now() + ms;
      let last: Http | null = null;
      while (Date.now() < end) {
        last = await read(n);
        if (ok(last)) return last;
        await Bun.sleep(1000);
      }
      throw new Error(`${what}: waited ${ms / 1000}s, got ${JSON.stringify(last)}`);
    };
    const declare = async (n: string, body: Record<string, unknown>) => {
      const res = await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ source: "http", every: "30s", webhook_url: hookUrl(`/${n.split(" ").join("-")}`), ...body }),
      });
      if (res.status !== 201) throw new Error(`PUT an http monitor should create, got ${res.status} ${await res.text()}`);
    };
    try {
      // The editor's Send: one request from the node, each line's result, nothing stored.
      const sentRes = await fetch(`${APP_URL}/api/monitors/send`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: `${stands.http}/health`, method: "GET", conditions: 'status == 200\n$.db == "ok"\n$.queue.depth < 2\ntime < 5000ms   warn' }),
      });
      const sent = (await sentRes.json()) as {
        response: { status: number } | null;
        timings: Record<string, number | null>;
        verdict: { result: string; line: string | null; lines: Array<{ text: string; level: string; pass: boolean | null; got: string }> };
      };
      // Each line: its text, whether it held, and what it read (the time is whatever it took).
      const want: Array<[string, boolean, string | null]> = [
        ["status == 200", true, "200"],
        ['$.db == "ok"', true, '"ok"'],
        ["$.queue.depth < 2", false, "3"],
        ["time < 5000ms", true, null],
      ];
      const lineWrong = want.some(([text, pass, value], i) => {
        const l = sent.verdict?.lines[i];
        return l?.text !== text || l.pass !== pass || (value !== null && l.got !== value);
      });
      if (
        sent.response?.status !== 200 ||
        sent.verdict.result !== "fail" ||
        sent.verdict.line !== "$.queue.depth < 2" ||
        lineWrong ||
        sent.verdict.lines[3]?.level !== "warn" ||
        typeof sent.timings.wait !== "number"
      ) {
        throw new Error(`Send should show each line's result, got ${JSON.stringify(sent)}`);
      }
      const redirectSend = (await (
        await fetch(`${APP_URL}/api/monitors/send`, { method: "POST", headers: auth, body: JSON.stringify({ url: `${stands.http}/redirect` }) })
      ).json()) as { response: { status: number } | null; verdict: { result: string; why: string } };
      if (redirectSend.response?.status !== 302 || redirectSend.verdict.result !== "fail" || !redirectSend.verdict.why.startsWith("redirects to https://example.com/elsewhere")) {
        throw new Error(`a redirect off its host should fail, not be followed, got ${JSON.stringify(redirectSend)}`);
      }

      stands.flip(503);
      await declare(names.flip, { url: `${stands.http}/flip`, fail_after: 2, headers: { Authorization: "Bearer e2e-secret" } });
      await declare(names.db, { url: `${stands.http}/db-down`, conditions: ["status == 200", '$.db == "ok"'], fail_after: 1 });
      await declare(names.slow, { url: `${stands.http}/slow`, conditions: ["status == 200", "time < 300ms warn"], fail_after: 1 });
      await declare(names.cert, { url: `${stands.https}/health`, conditions: ["cert > 30d"], fail_after: 1 });
      await declare(names.redirect, { url: `${stands.http}/redirect`, fail_after: 1 });

      // One 503 does not open it; the second, 30s later, does.
      const first = await until("the first 503", names.flip, (m) => (m.http?.fails_in_row ?? 0) >= 1, 15_000);
      if (first.state !== "ok") throw new Error(`one 503 should not open it, got ${JSON.stringify(first)}`);
      if (stands.last.get("/flip")?.headers.authorization !== "Bearer e2e-secret") throw new Error("an http monitor should send its headers");
      if (JSON.stringify(first.http?.headers) !== '["Authorization"]' || JSON.stringify(first).includes("e2e-secret")) {
        throw new Error(`a header's value should never be shown back, got ${JSON.stringify(first.http)}`);
      }
      const opened = await until("two 503s in a row open it", names.flip, (m) => m.state === "open");
      if (opened.http?.last_run?.status !== 503 || (opened.http?.fails_in_row ?? 0) < 2) {
        throw new Error(`it should open on its second 503, got ${JSON.stringify(opened)}`);
      }

      const db = await read(names.db);
      if (db.state !== "open" || db.http?.last_run?.line !== '$.db == "ok"' || db.http.last_run.why !== '$.db is "down", not "ok"') {
        throw new Error(`$.db == "ok" should fail on {"db":"down"} and name the line, got ${JSON.stringify(db)}`);
      }
      const slow = await read(names.slow);
      if (slow.state !== "ok" || slow.last_result !== "warn" || slow.http?.last_run?.line !== "time < 300ms") {
        throw new Error(`a warn line over its time should warn, not open, got ${JSON.stringify(slow)}`);
      }
      const cert = await read(names.cert);
      const certWhy = cert.http?.last_run?.why ?? "";
      if (cert.state !== "open" || !(certDir ? /^certificate expires in (19|20) days$/.test(certWhy) : certWhy === "certificate is not trusted")) {
        throw new Error(`cert > 30d should fail on a certificate with 20 days left, got ${JSON.stringify(cert)}`);
      }
      const redirect = await read(names.redirect);
      if (redirect.state !== "open" || !redirect.http?.last_run?.why?.startsWith("redirects to https://example.com/elsewhere")) {
        throw new Error(`a monitor whose URL redirects off its host should fail, got ${JSON.stringify(redirect)}`);
      }

      stands.flip(200);
      const resolved = await until("a 200 resolves it", names.flip, (m) => m.state === "ok", 45_000);
      const stretch = resolved.stretches?.[0];
      if (!stretch?.resolved_at || stretch.closed_by !== "ok") throw new Error(`it should resolve on the 200, got ${JSON.stringify(resolved)}`);
      const flipCalls = calls.filter((c) => c.path === `/${names.flip.split(" ").join("-")}`).map((c) => c.state);
      if (JSON.stringify(flipCalls) !== '["open","resolved"]') throw new Error(`it should call once open and once resolved, got ${JSON.stringify(flipCalls)}`);

      // Watch's ticks: each run is a result, the worst of its minute, for the lanes.
      const lanes = (await (await fetch(`${APP_URL}/api/monitors`, { headers: auth })).json()) as {
        monitors: Array<{ id: string; name: string }>;
        results: Array<{ monitor_id: string; result: string; via: string }>;
      };
      const laneOf = (n: string) => {
        const id = lanes.monitors.find((m) => m.name === n)?.id;
        return lanes.results.filter((r) => r.monitor_id === id && r.via === "http").map((r) => r.result);
      };
      if (!laneOf(names.flip).includes("fail") || !laneOf(names.slow).includes("warn")) {
        throw new Error(`each run should be a result on its lane, got ${JSON.stringify({ flip: laneOf(names.flip), slow: laneOf(names.slow) })}`);
      }

      // Every run is a row, found by its monitor, and its time is the metric monitor_duration_ms.
      const from = new Date(Date.now() - 15 * 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const rowsFor = async (q: string) =>
        (await (await fetch(`${APP_URL}/api/search?${new URLSearchParams({ from, to, q }).toString()}`, { headers: auth })).json()) as {
          events: Array<{ level: string; message: string; attrs?: Record<string, string> }>;
          total: number;
        };
      const flipRows = await rowsFor(`monitor:"${names.flip}" source:http`);
      const statuses = flipRows.events.map((e) => e.attrs?.["http.status"]).reverse();
      if (statuses.slice(0, 2).join(",") !== "503,503" || statuses.at(-1) !== "200" || flipRows.events.some((e) => !e.attrs?.duration_ms)) {
        throw new Error(`each run should be a row with http.status and duration_ms, got ${JSON.stringify(flipRows.events)}`);
      }
      const failRows = await rowsFor(`monitor:${names.db} status:fail`);
      if (failRows.total < 1 || failRows.events[0]?.attrs?.line !== '$.db == "ok"' || failRows.events[0]?.level !== "error") {
        throw new Error(`a failing run's row should name its line, got ${JSON.stringify(failRows.events[0])}`);
      }
      const metricNames = (await (
        await fetch(`${APP_URL}/api/metric-names?${new URLSearchParams({ range: "15m", find: "monitor_duration" }).toString()}`, { headers: auth })
      ).json()) as { keys: Array<{ k: string }> };
      if (!metricNames.keys.some((k) => k.k === "monitor_duration_ms")) {
        throw new Error(`duration_ms should also be the metric monitor_duration_ms, got ${JSON.stringify(metricNames)}`);
      }
    } finally {
      for (const n of Object.values(names)) {
        await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { method: "DELETE", headers: auth });
      }
      hook.stop(true);
      stands.stop();
      if (!certDir) certs.cleanup();
    }
  }

  // #180, after #178: TCP and certificate monitors run on the same loop, against stand-ins on
  // spare ports: a closed port opens after two runs, cert > 30d fails on a 20-day certificate,
  // STARTTLS on a stand-in SMTP server reads its certificate, and each failing row says why. As
  // for #178, the app trusts the stand-ins' CA only when started with NODE_EXTRA_CA_CERTS and this
  // run is given TOPOSCOPE_E2E_CERTS; without them a certificate reads as not trusted, still read.
  {
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    const certDir = envValue("TOPOSCOPE_E2E_CERTS");
    const certs = certDir ? readCerts(certDir) : makeCerts(20);
    const stands = await startNetStands(certs);
    const names = {
      closed: `e2e tcp closed ${marker}`,
      cert: `e2e cert ${marker}`,
      mail: `e2e smtp cert ${marker}`,
    };
    type Net = {
      state: string;
      net: { fails_in_row: number; last_run: { result: string; connected: boolean; line: string | null; why: string | null; cert_subject: string | null } | null } | null;
      stretches?: Array<{ opened_at: number; resolved_at: number | null }>;
    };
    const read = async (n: string) =>
      (await (await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { headers: auth })).json()) as Net;
    const until = async (what: string, n: string, ok: (m: Net) => boolean, ms = 75_000) => {
      const end = Date.now() + ms;
      let last: Net | null = null;
      while (Date.now() < end) {
        last = await read(n);
        if (ok(last)) return last;
        await Bun.sleep(1000);
      }
      throw new Error(`${what}: waited ${ms / 1000}s, got ${JSON.stringify(last)}`);
    };
    const declare = async (n: string, body: Record<string, unknown>) => {
      const res = await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ every: "30s", ...body }),
      });
      if (res.status !== 201) throw new Error(`PUT a ${String(body.source)} monitor should create, got ${res.status} ${await res.text()}`);
    };
    try {
      // The editor's Send: one connect from the node, each line's result, nothing stored.
      const sent = (await (
        await fetch(`${APP_URL}/api/monitors/send`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ source: "tcp", target: stands.open, conditions: "connected\ntime < 5000ms" }),
        })
      ).json()) as { connected: boolean; verdict: { result: string; lines: Array<{ text: string; pass: boolean | null }> } };
      if (!sent.connected || sent.verdict.result !== "ok" || sent.verdict.lines.map((l) => l.pass).join() !== "true,true") {
        throw new Error(`Send on an open port should connect and pass, got ${JSON.stringify(sent)}`);
      }

      await declare(names.closed, { source: "tcp", target: stands.closed, conditions: ["connected"], fail_after: 2 });
      await declare(names.cert, { source: "cert", target: stands.tls, conditions: ["cert > 30d"], fail_after: 1 });
      await declare(names.mail, { source: "cert", target: stands.smtp, starttls: "smtp", conditions: ["cert > 14d", "cert name == localhost"] });

      // One refused connect does not open it; the second, 30s later, does.
      const first = await until("the first refused connect", names.closed, (m) => (m.net?.fails_in_row ?? 0) >= 1, 15_000);
      if (first.state !== "ok") throw new Error(`one refused connect should not open it, got ${JSON.stringify(first)}`);
      const opened = await until("two refused connects in a row open it", names.closed, (m) => m.state === "open");
      if (opened.net?.last_run?.why !== "connect ECONNREFUSED" || opened.net.last_run.line !== "connected") {
        throw new Error(`a closed port should open on its second run, saying why, got ${JSON.stringify(opened)}`);
      }

      const cert = await read(names.cert);
      const certWhy = cert.net?.last_run?.why ?? "";
      if (cert.state !== "open" || !(certDir ? /^certificate expires in (19|20) days$/.test(certWhy) : certWhy === "certificate is not trusted")) {
        throw new Error(`cert > 30d should fail on a certificate with 20 days left, got ${JSON.stringify(cert)}`);
      }
      const mail = await read(names.mail);
      if (mail.net?.last_run?.cert_subject !== "localhost" || (certDir ? mail.net.last_run.result !== "ok" : mail.net.last_run.why !== "certificate is not trusted")) {
        throw new Error(`STARTTLS on a stand-in SMTP server should read its certificate, got ${JSON.stringify(mail)}`);
      }

      // Every run is a row, and a failing one says why.
      const from = new Date(Date.now() - 15 * 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const rowsFor = async (q: string) =>
        (await (await fetch(`${APP_URL}/api/search?${new URLSearchParams({ from, to, q }).toString()}`, { headers: auth })).json()) as {
          events: Array<{ level: string; message: string; attrs?: Record<string, string> }>;
          total: number;
        };
      const closedRows = await rowsFor(`monitor:"${names.closed}" source:tcp status:fail`);
      if (closedRows.total < 2 || closedRows.events.some((e) => e.attrs?.error !== "connect ECONNREFUSED" || e.level !== "error")) {
        throw new Error(`each failing tcp run should be a row saying why, got ${JSON.stringify(closedRows.events)}`);
      }
      const certRows = await rowsFor(`monitor:"${names.cert}" source:cert`);
      if (certRows.total < 1 || certRows.events[0]?.attrs?.error !== certWhy) {
        throw new Error(`a failing certificate run's row should say why, got ${JSON.stringify(certRows.events[0])}`);
      }
      const mailRows = await rowsFor(`monitor:"${names.mail}" starttls:smtp`);
      if (mailRows.total < 1 || mailRows.events[0]?.attrs?.["cert.subject"] !== "localhost") {
        throw new Error(`a STARTTLS run's row should name its certificate, got ${JSON.stringify(mailRows.events[0])}`);
      }
    } finally {
      for (const n of Object.values(names)) {
        await fetch(`${APP_URL}/api/monitors/${encodeURIComponent(n)}`, { method: "DELETE", headers: auth });
      }
      stands.stop();
      if (!certDir) certs.cleanup();
    }
  }

  // Shares (#225): one scope of numbers, read with the share's secret and nothing else.
  {
    const auth = { "content-type": "application/json", authorization: basicAuth() };
    const svc = `share-${marker}`;
    const ts = new Date().toISOString();
    const points = [
      { name: `fleet_${marker}`, value: 2, ts, labels: { service: svc, host: "box-1" } },
      { name: `fleet_${marker}`, value: 4, ts, labels: { service: svc, host: "box-2" } },
      { name: `fleet_${marker}`, value: 99, ts, labels: { service: "other", host: "box-9" } },
      { name: `billing_${marker}`, value: 1, ts, labels: { service: svc } },
    ];
    const metricsSent = await fetch(`${APP_URL}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify(points),
    });
    const logsSent = await fetch(`${APP_URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${INGEST_TOKEN}` },
      body: [
        { service: svc, host: "box-1", level: "error", message: `${marker} share row`, attrs: { account_id: "acct-7" } },
        { service: svc, host: "box-2", level: "info", message: `${marker} share row`, attrs: { account_id: "acct-8" } },
        { service: "other", host: "box-9", level: "info", message: `${marker} share row` },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    });
    if (!metricsSent.ok || !logsSent.ok) {
      throw new Error(`share fixtures not ingested: ${metricsSent.status} ${logsSent.status}`);
    }
    const name = `e2e-${marker.toLowerCase()}`;
    const created = await fetch(`${APP_URL}/api/shares`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        expires_at: Date.now() + 86_400_000,
        scope: {
          metric_names: [`fleet_*`],
          metric_labels: `service:${svc}`,
          logs: `service:${svc}`,
          split: ["host"],
          narrow: ["host"],
        },
      }),
    });
    const { secret, share } = (await created.json()) as { secret?: string; share?: { name: string } };
    if (created.status !== 201 || !secret || share?.name !== name) {
      throw new Error(`creating a share should answer 201 with its secret once, got ${created.status}`);
    }
    const listed = JSON.stringify(await (await fetch(`${APP_URL}/api/shares`, { headers: auth })).json());
    if (listed.includes(secret)) {
      throw new Error("the share list must never carry a secret");
    }
    const read = (path: string, headers: Record<string, string> = { authorization: `Bearer ${secret}` }) =>
      fetch(`${APP_URL}${path}`, { headers });
    const window = new URLSearchParams({ from: new Date(Date.now() - 10 * 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

    const series = (await (await read(`/share/v1/series?${window}&metric=fleet_${marker}&split=host`)).json()) as {
      series?: { splits?: Array<{ key: string }>; expr?: string; buckets: unknown[] };
    };
    const hosts = (series.series?.splits ?? []).map((s) => s.key).sort();
    if (JSON.stringify(hosts) !== JSON.stringify(["box-1", "box-2"]) || series.series?.expr !== undefined) {
      throw new Error(`a share's metric read should hold its scope's hosts only and not state the scope, got ${JSON.stringify(series)}`);
    }
    const counted = (await (await read(`/share/v1/series?${window}&agg=count&ml=host:box-1`)).json()) as { total?: number; events?: unknown };
    if (counted.total !== 1 || counted.events !== undefined) {
      throw new Error(`a share's log count should be the scope's narrowed rows, never events, got ${JSON.stringify(counted)}`);
    }
    const top = (await (await read(`/share/v1/top?${window}&key=host`)).json()) as { values?: Array<{ v: string }> };
    if (JSON.stringify((top.values ?? []).map((v) => v.v).sort()) !== JSON.stringify(["box-1", "box-2"])) {
      throw new Error(`a share's Top-N should count the scope's rows only, got ${JSON.stringify(top)}`);
    }
    const refusals: Array<[string, number]> = [
      [`/share/v1/series?${window}&metric=billing_${marker}`, 404],
      [`/share/v1/series?${window}&metric=fleet_${marker}&split=account_id`, 400],
      [`/share/v1/series?${window}&agg=count&ml=account_id:acct-7`, 400],
      [`/share/v1/series?${window}&agg=max:duration_ms`, 400],
      [`/share/v1/top?${window}&key=account_id`, 400],
    ];
    for (const [path, status] of refusals) {
      const res = await read(path);
      if (res.status !== status) {
        throw new Error(`${path} should be ${status} through a share, got ${res.status}`);
      }
    }
    for (const path of [`/api/search?${window}&q=service:${svc}`, "/api/saved-searches", "/api/shares"]) {
      const res = await read(path);
      if (res.status !== 401) {
        throw new Error(`a share secret must not open ${path}, got ${res.status}`);
      }
    }
    for (const headers of [{ authorization: basicAuth() }, { authorization: `Bearer ${INGEST_TOKEN}` }, {} as Record<string, string>]) {
      const res = await read(`/share/v1/names?${window}`, headers);
      if (res.status !== 401 || res.headers.get("www-authenticate")) {
        throw new Error(`only a share secret opens /share/v1, with no Basic prompt; got ${res.status}`);
      }
    }
    const names = (await (await read(`/share/v1/names?${window}`)).json()) as { metrics?: Array<{ name: string }>; values?: Record<string, string[]> };
    if (JSON.stringify(names.metrics?.map((m) => m.name)) !== JSON.stringify([`fleet_${marker}`]) || names.values?.host?.includes("box-9")) {
      throw new Error(`names should list only the scope's metrics and values, got ${JSON.stringify(names)}`);
    }
    // Limits (#226): the finest bar, the longest window, the oldest reach, reads per minute.
    const snapped = (await (await read(`/share/v1/series?range=15m&metric=fleet_${marker}`)).json()) as { step_ms?: number };
    if (snapped.step_ms !== 60_000) {
      throw new Error(`Auto under a 1m floor should snap to 1m bars, got ${JSON.stringify(snapped)}`);
    }
    for (const [path, why] of [
      [`/share/v1/series?range=1h&step=10s&metric=fleet_${marker}`, "finest bar is 1m"],
      [`/share/v1/series?range=30d&metric=fleet_${marker}`, "longest window is 7d"],
      [`/share/v1/series?from=${new Date(Date.now() - 40 * 86_400_000).toISOString()}&to=${new Date(Date.now() - 35 * 86_400_000).toISOString()}&metric=fleet_${marker}`, "reaches back 30d"],
    ] as const) {
      const res = await read(path);
      const body = (await res.json()) as { error?: string };
      if (res.status !== 400 || !body.error?.includes(why)) {
        throw new Error(`${path} should be refused with "${why}", got ${res.status} ${JSON.stringify(body)}`);
      }
    }
    const used = (await (await fetch(`${APP_URL}/api/shares`, { headers: auth })).json()) as {
      shares: Array<{ name: string; use: { reads_24h: number; refused_24h: number; last_read_at: string | null } }>;
    };
    const mine = used.shares.find((s) => s.name === name)?.use;
    if (!mine || mine.reads_24h < 4 || mine.refused_24h < 8 || !mine.last_read_at) {
      throw new Error(`the share list should say how the share was used, got ${JSON.stringify(mine)}`);
    }
    const slow = `${name}-slow`;
    const slowMade = (await (
      await fetch(`${APP_URL}/api/shares/${slow}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ expires_at: Date.now() + 86_400_000, scope: { metric_names: ["fleet_*"] }, limits: { reads_per_minute: 2 } }),
      })
    ).json()) as { secret?: string };
    // Each read asks something new: an answer served again from the cache (#227) is off the rate.
    const slowRead = (n: number) => read(`/share/v1/names?range=1h&try=${n}`, { authorization: `Bearer ${slowMade.secret}` });
    const statuses = [(await slowRead(1)).status, (await slowRead(2)).status];
    const third = await slowRead(3);
    if (statuses.join() !== "200,200" || third.status !== 429 || !third.headers.get("retry-after")) {
      throw new Error(`a share's third read in a minute at 2/min should be 429 with Retry-After, got ${statuses} ${third.status}`);
    }
    await fetch(`${APP_URL}/api/shares/${slow}`, { method: "DELETE", headers: auth });

    // Embed (#227): a ticket from the secret, the share's own frame rules, answers kept a moment.
    const framed = await fetch(`${APP_URL}/api/shares/${name}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        expires_at: Date.now() + 86_400_000,
        scope: { metric_names: ["fleet_*"], metric_labels: `service:${svc}`, logs: `service:${svc}`, split: ["host"], narrow: ["host"] },
        embed: { frame_ancestors: ["https://admin.example.com"] },
      }),
    });
    if (framed.status !== 200) {
      throw new Error(`changing a share should keep it and answer 200, got ${framed.status}`);
    }
    const minted = await fetch(`${APP_URL}/share/v1/tickets`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    const { ticket } = (await minted.json()) as { ticket?: string };
    if (minted.status !== 200 || !ticket?.startsWith("tst1_")) {
      throw new Error(`the secret should mint a ticket, got ${minted.status}`);
    }
    // The Share dialog's preview (#236): signed in, a short ticket that reads like any other.
    const preview = await fetch(`${APP_URL}/api/shares/${name}/ticket`, { method: "POST", headers: auth });
    const previewTicket = ((await preview.json()) as { ticket?: string }).ticket;
    const previewRead = await read(`/share/v1/names?range=1h&preview=${marker}`, { authorization: `Bearer ${previewTicket}` });
    if (preview.status !== 200 || previewRead.status !== 200) {
      throw new Error(`a signed-in preview ticket should read its share, got ${preview.status} ${previewRead.status}`);
    }
    if ((await fetch(`${APP_URL}/api/shares/${name}/ticket`, { method: "POST", headers: { authorization: `Bearer ${secret}` } })).status !== 401) {
      throw new Error("a share's secret must not mint a preview ticket under /api");
    }
    const byTicket = { authorization: `Bearer ${ticket}` };
    const again =await fetch(`${APP_URL}/share/v1/tickets`, { method: "POST", headers: byTicket });
    if (again.status !== 403) {
      throw new Error(`a ticket must not mint a ticket, got ${again.status}`);
    }
    const panelPath = `/share/v1/series?range=1h&metric=fleet_${marker}&e2e=${marker}`;
    const first = await read(panelPath, byTicket);
    const second = await read(panelPath, byTicket);
    if (first.status !== 200 || second.status !== 200 || !second.headers.get("cache-control")?.startsWith("private, max-age=")) {
      throw new Error(`a ticket should read its share's panel, kept a moment: ${first.status} ${second.status} ${second.headers.get("cache-control")}`);
    }
    if ((await read(`/api/saved-searches`, byTicket)).status !== 401) {
      throw new Error("a ticket must open nothing under /api");
    }
    const page = await fetch(`${APP_URL}/embed?ticket=${encodeURIComponent(ticket)}&metric=fleet_${marker}&range=1h`);
    if (page.status !== 200 || page.headers.get("content-security-policy") !== "frame-ancestors 'self' https://admin.example.com" || page.headers.get("www-authenticate")) {
      throw new Error(`/embed should be framed by the share's origins only, without a sign-in: ${page.status} ${page.headers.get("content-security-policy")}`);
    }
    const loader = await fetch(`${APP_URL}/embed.js`);
    if (loader.status !== 200 || !(loader.headers.get("content-type") ?? "").includes("javascript")) {
      throw new Error(`/embed.js should be a script anyone can load, got ${loader.status}`);
    }
    const signInPage = await fetch(`${APP_URL}/`, { headers: { accept: "text/html" } });
    if (signInPage.headers.get("content-security-policy") !== "frame-ancestors 'none'") {
      throw new Error(`every other page should refuse to be framed, got ${signInPage.headers.get("content-security-policy")}`);
    }

    await fetch(`${APP_URL}/api/shares/${name}`, { method: "DELETE", headers: auth });
    const afterRevoke = await read(`/share/v1/names?${window}`);
    if (afterRevoke.status !== 401) {
      throw new Error(`a revoked share should answer 401 at once, got ${afterRevoke.status}`);
    }
    if ((await read(panelPath, byTicket)).status !== 401) {
      throw new Error("a revoked share's tickets should stop at once, cached answer or not");
    }
  }

  console.log("e2e ok: ingest → search → surrounding → otlp protobuf → otlp grpc → syslog → token → run → alert series fire → follow-id → traces → profiles → load:live → push monitor late, open, resolved → watchdog → monitor open, remind, resolved → fewer than: quiet, can't tell, resolved → http monitor open, warn, resolved → tcp monitor open, certificate fail, starttls → shares");
}

await main();
