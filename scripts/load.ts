import { fakeLogEvent } from "../src/shared/fake-event";
import { generateLogsInClickHouse } from "./load-ch-generate";
import {
  assignLoadChannels,
  countChannels,
  formatChannelCounts,
} from "./load-channel";
import { encodeLoadBatch, postMetrics, sendEncoded } from "./load-http";
import { runLiveLoad } from "./load-live";
import { parseLoadProfile } from "./load-profile";
import { envValue } from "../src/shared/env";
import { parseLiveArgs } from "./load-rates";

const APP_URL = envValue("TOPOSCOPE_URL") ?? "http://127.0.0.1:8080";
const INGEST_TOKEN = envValue("TOPOSCOPE_INGEST_TOKEN") ?? "toposcope-ingest";
const PASSWORD = envValue("TOPOSCOPE_PASSWORD") ?? "toposcope";
const SYSLOG_HOST = process.env.SYSLOG_UDP_HOST ?? "127.0.0.1";
const SYSLOG_PORT = Number(process.env.SYSLOG_UDP_PORT ?? "5514");
const BATCH = 500;

function basicAuth(): string {
  return `Basic ${btoa(`toposcope:${PASSWORD}`)}`;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      const json = (await res.json()) as { ok?: boolean };
      if (res.ok && json.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  throw new Error(`health check did not pass at ${APP_URL}`);
}

async function fetchJson(url: string, name: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { authorization: basicAuth() } });
      if (!res.ok) {
        throw new Error(`${name} failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { events?: unknown[] };
      if (url.includes("events=0") && Array.isArray(json.events) && json.events.length > 0) {
        throw new Error(`${name} events=0 returned an event page`);
      }
      return;
    } catch (err) {
      last = err;
      if (attempt < 2) {
        await Bun.sleep(1000 * (attempt + 1));
      }
    }
  }
  throw last;
}

async function timed(name: string, fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`${name.padEnd(28)} ${ms.toFixed(0)}ms`);
  return ms;
}

const loadEnv = { url: APP_URL, token: INGEST_TOKEN };
const syslog = { host: SYSLOG_HOST, port: SYSLOG_PORT };

async function waitForMarkerTotal(
  marker: string,
  n: number,
  from: string,
  to: string,
): Promise<void> {
  const url = `${APP_URL}/api/search?${new URLSearchParams({
    from,
    to,
    q: marker,
  })}`;
  let last = -1;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: basicAuth() } });
    if (!res.ok) {
      throw new Error(`marker search failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { total: number };
    last = json.total;
    if (last === n) {
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `expected ${n} events with marker ${marker}, search total=${last}`,
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === "live") {
    await waitForHealth();
    await runLiveLoad(parseLiveArgs(process.argv.slice(3)));
    return;
  }
  const profile = parseLoadProfile(process.argv[2] ?? process.env.LOAD_PROFILE);
  await waitForHealth();
  if (profile.id === "10m") {
    console.log(
      "profile 10m/7d writes 10M rows through mixed ingest paths — several minutes, disk grows",
    );
  }
  if (profile.id === "100m") {
    console.log(
      "profile 100m/7d inserts 100M rows in ClickHouse (INSERT SELECT, not /api/ingest). A few GB. Truncate first. Use the 7d range pill to see the whole window.",
    );
  }
  console.log(
    `profile ${profile.id}: ${profile.n.toLocaleString()} events over ${profile.range}`,
  );

  const marker = `load${profile.id}${Date.now()}`;
  const now = Date.now();
  const ingestT0 = performance.now();
  if (profile.via === "clickhouse") {
    await generateLogsInClickHouse({
      n: profile.n,
      nowMs: now,
      windowMs: profile.windowMs,
      marker,
    });
  } else {
    const batchCount = Math.ceil(profile.n / BATCH);
    const channels = assignLoadChannels(batchCount, now >>> 0);
    console.log(`ingest mix ${formatChannelCounts(countChannels(channels))}`);
    const udp = await Bun.udpSocket({});
    let next = 0;
    let ingested = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const start = next;
        next += BATCH;
        if (start >= profile.n) {
          return;
        }
        const end = Math.min(start + BATCH, profile.n);
        const batch = [];
        for (let i = start; i < end; i++) {
          batch.push(
            fakeLogEvent({
              i,
              n: profile.n,
              now,
              windowMs: profile.windowMs,
              marker,
            }),
          );
        }
        const channel = channels[Math.floor(start / BATCH)];
        if (!channel) {
          throw new Error(`missing load channel for batch ${start}`);
        }
        const n = await sendEncoded(
          loadEnv,
          encodeLoadBatch(channel, batch),
          udp,
          syslog,
        );
        ingested += n;
        if (end % 50_000 === 0 || end === profile.n) {
          const elapsed = (performance.now() - ingestT0) / 1000;
          console.log(
            `  ingested ${end.toLocaleString()}/${profile.n.toLocaleString()} (${(end / elapsed).toFixed(0)}/s)`,
          );
        }
      }
    }

    try {
      await Promise.all(
        Array.from({ length: profile.ingestConcurrency }, () => worker()),
      );
    } finally {
      udp.close();
    }
    if (ingested !== profile.n) {
      throw new Error(`expected ingested=${profile.n}, got ${ingested}`);
    }
    const slackMs = 60_000;
    await waitForMarkerTotal(
      marker,
      profile.n,
      new Date(now - profile.windowMs - slackMs).toISOString(),
      new Date(now + slackMs).toISOString(),
    );
  }
  const ingestMs = performance.now() - ingestT0;
  console.log(
    `ingest ${profile.n} in ${(ingestMs / 1000).toFixed(2)}s (${(profile.n / (ingestMs / 1000)).toFixed(0)}/s)`,
  );

  const metricPoints = [];
  const metricStep = 60_000;
  const metricCount = Math.min(120, Math.max(12, Math.floor(profile.windowMs / metricStep)));
  for (let i = 0; i < metricCount; i++) {
    const ts = new Date(now - (metricCount - 1 - i) * metricStep).toISOString();
    metricPoints.push({
      name: "cpu_seconds",
      value: 0.2 + (i % 10) * 0.05,
      ts,
    });
  }
  const metricIngested = await postMetrics(loadEnv, metricPoints);
  if (metricIngested !== metricPoints.length) {
    throw new Error(`expected metric ingested=${metricPoints.length}, got ${metricIngested}`);
  }

  const followHex = `${Date.now().toString(16).padStart(16, "0")}${"cafef00d".repeat(2)}`.slice(
    0,
    32,
  );
  if (profile.via !== "clickhouse") {
    const followRes = await fetch(`${APP_URL}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        service: "api",
        level: "info",
        message: `${marker}-follow`,
        attrs: { request_id: followHex },
      }),
    });
    if (!followRes.ok) {
      throw new Error(`follow ingest failed: ${followRes.status} ${await followRes.text()}`);
    }
  }

  const range = profile.range;
  const markerQ = new URLSearchParams({
    range,
    q: `service:api ${marker}`,
  });
  const mv: Array<[string, string]> = [
    [`search empty ${range}`, `${APP_URL}/api/search?range=${range}`],
    [
      "search level:error",
      `${APP_URL}/api/search?range=${range}&q=level:error`,
    ],
    [
      "search user_id",
      `${APP_URL}/api/search?range=${range}&q=user_id:u-5`,
    ],
    [
      "search host",
      `${APP_URL}/api/search?range=${range}&q=host:api-1`,
    ],
    [
      "search status:5*",
      `${APP_URL}/api/search?range=${range}&q=${encodeURIComponent("status:5*")}`,
    ],
    [
      "search level OR",
      `${APP_URL}/api/search?range=${range}&q=${encodeURIComponent("level:error OR level:fatal")}`,
    ],
    [
      "search p99 duration_ms",
      `${APP_URL}/api/search?range=${range}&agg=${encodeURIComponent("p99:duration_ms")}`,
    ],
    [
      "search events=0 p99",
      `${APP_URL}/api/search?range=${range}&events=0&agg=${encodeURIComponent("p99:duration_ms")}`,
    ],
    [
      "search events=0 split service",
      `${APP_URL}/api/search?range=${range}&events=0&split=service`,
    ],
    [
      "search events=0 avg duration_ms",
      `${APP_URL}/api/search?range=${range}&events=0&agg=${encodeURIComponent("avg:duration_ms")}`,
    ],
    [
      "search events=0 metric cpu_seconds",
      `${APP_URL}/api/search?range=${range}&events=0&metric=cpu_seconds`,
    ],
    [
      "attr-facets status",
      `${APP_URL}/api/attr-facets?range=${range}&attrs=status`,
    ],
    ["throughput", `${APP_URL}/api/throughput`],
    ["system", `${APP_URL}/api/system`],
  ];
  const scan: Array<[string, string]> =
    profile.smoke === "mv"
      ? []
      : [
          [
            "search message timeout",
            `${APP_URL}/api/search?range=${range}&q=timeout`,
          ],
          [
            "search timeout p99",
            `${APP_URL}/api/search?range=${range}&events=0&q=timeout&agg=${encodeURIComponent("p99:duration_ms")}`,
          ],
          [
            "search message marker",
            `${APP_URL}/api/search?${markerQ.toString()}`,
          ],
          [
            "search request_id hex",
            `${APP_URL}/api/search?range=${range}&q=request_id:${followHex}`,
          ],
          [`facets ${range}`, `${APP_URL}/api/facets?range=${range}`],
        ];

  const slow: string[] = [];
  for (const [name, url] of mv) {
    const ms = await timed(name, () => fetchJson(url, name));
    if (ms >= profile.mvMs) {
      slow.push(`${name} ${ms.toFixed(0)}ms (>= ${profile.mvMs}ms)`);
    }
  }
  for (const [name, url] of scan) {
    const ms = await timed(name, () => fetchJson(url, name));
    if (ms >= profile.scanMs) {
      slow.push(`${name} ${ms.toFixed(0)}ms (>= ${profile.scanMs}ms)`);
    }
  }

  const parallelT0 = performance.now();
  const parallel = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(`${APP_URL}/api/search?range=${range}&q=level:error`, {
        headers: { authorization: basicAuth() },
      }),
    ),
  );
  const parallelMs = performance.now() - parallelT0;
  for (const res of parallel) {
    if (!res.ok) {
      throw new Error(`parallel search failed: ${res.status}`);
    }
  }
  console.log(`${"search x4 parallel".padEnd(28)} ${parallelMs.toFixed(0)}ms`);
  if (parallelMs >= profile.mvMs) {
    slow.push(`search x4 parallel ${parallelMs.toFixed(0)}ms (>= ${profile.mvMs}ms)`);
  }

  if (slow.length > 0) {
    throw new Error(`load ${profile.id} exceeded budget:\n${slow.join("\n")}`);
  }
  if (profile.smoke === "mv") {
    console.log(
      `load ok: ${profile.id} ${profile.n.toLocaleString()} / ${profile.range} (mv < ${profile.mvMs}ms)`,
    );
    return;
  }
  console.log(
    `load ok: ${profile.id} ${profile.n.toLocaleString()} / ${profile.range} (mv < ${profile.mvMs}ms, scan < ${profile.scanMs}ms)`,
  );
}

await main();
