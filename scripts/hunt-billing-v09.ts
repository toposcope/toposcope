import { writeFile } from "node:fs/promises";
import {
  buildHuntSlice,
  huntBugFingerprint,
  huntFirstSeen,
  HUNT_CUSTOMER,
  HUNT_FLAG,
  HUNT_MARK_TITLE,
  HUNT_PROBE_METRIC,
  HUNT_PROBE_ML,
  HUNT_ROW_COLS,
  type HuntManifest,
} from "./hunt-billing-v09-events";
import { postIngest, postMarks, postProbes } from "./load-http";
import { envValue } from "../src/shared/env";
import { formatChangeMarkLabel } from "../src/shared/change-mark";

const APP_URL = envValue("TOPOSCOPE_URL") ?? "http://127.0.0.1:8080";
const INGEST_TOKEN = envValue("TOPOSCOPE_INGEST_TOKEN") ?? "toposcope-ingest";
const PASSWORD = envValue("TOPOSCOPE_PASSWORD") ?? "toposcope";
const UI_URL = process.env.TOPOSCOPE_UI_URL ?? "http://127.0.0.1:5173";
const MANIFEST =
  process.env.TOPOSCOPE_HUNT_JSON ?? "/tmp/toposcope-hunt.json";
const BATCH = 500;

const loadEnv = { url: APP_URL, token: INGEST_TOKEN };

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

async function waitForQueryTotal(
  q: string,
  min: number,
  from: string,
  to: string,
): Promise<number> {
  const url = `${APP_URL}/api/search?${new URLSearchParams({ from, to, q })}`;
  let last = -1;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: basicAuth() } });
    if (!res.ok) {
      throw new Error(`search ${q} failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { total: number };
    last = json.total;
    if (last >= min) {
      return last;
    }
    await Bun.sleep(500);
  }
  throw new Error(`expected >= ${min} events for ${q}, search total=${last}`);
}

async function waitForProbeOverlay(
  from: string,
  to: string,
): Promise<void> {
  const url = `${APP_URL}/api/search?${new URLSearchParams({
    from,
    to,
    events: "0",
    metric: HUNT_PROBE_METRIC,
    ml: HUNT_PROBE_ML,
  })}`;
  let last = "";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: basicAuth() } });
    if (!res.ok) {
      throw new Error(`probe overlay failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      agg?: { source?: string; buckets?: Array<{ v: number }> };
    };
    const buckets = json.agg?.buckets ?? [];
    const hasDown = buckets.some((bucket) => bucket.v === 0);
    const hasUp = buckets.some((bucket) => bucket.v === 1);
    if (json.agg?.source === "metric" && hasDown && hasUp) {
      return;
    }
    last = JSON.stringify(json.agg);
    await Bun.sleep(500);
  }
  throw new Error(`expected metric=up overlay with 0 and 1, last=${last}`);
}

async function main(): Promise<void> {
  await waitForHealth();
  const slice = buildHuntSlice(Date.now());
  console.log(
    `hunt billing-v09: ${slice.events.length.toLocaleString()} events, mark at midpoint, q=${slice.q}`,
  );

  const marked = await postMarks(loadEnv, [slice.mark]);
  if (marked !== 1) {
    throw new Error(`expected 1 change mark, got ${marked}`);
  }

  const probed = await postProbes(loadEnv, slice.probes);
  if (probed !== slice.probes.length) {
    throw new Error(`expected ${slice.probes.length} probes, got ${probed}`);
  }

  let ingested = 0;
  for (let i = 0; i < slice.events.length; i += BATCH) {
    const batch = slice.events.slice(i, i + BATCH);
    ingested += await postIngest(
      loadEnv,
      "/api/ingest",
      "application/json",
      JSON.stringify(batch),
    );
  }
  if (ingested !== slice.events.length) {
    throw new Error(`expected ingested=${slice.events.length}, got ${ingested}`);
  }

  const billing = await waitForQueryTotal(
    slice.q,
    slice.billingErrorBefore + slice.billingErrorAfter,
    slice.from,
    slice.to,
  );
  for (const bug of huntFirstSeen) {
    await waitForQueryTotal(
      `e1:${huntBugFingerprint(bug)}`,
      1,
      slice.from,
      slice.to,
    );
  }
  await waitForQueryTotal(
    `version:${HUNT_MARK_TITLE} ${slice.q}`,
    1,
    slice.from,
    slice.to,
  );
  await waitForQueryTotal(
    `customer:${HUNT_CUSTOMER} ${slice.q}`,
    1,
    slice.from,
    slice.to,
  );
  await waitForQueryTotal(
    `flag:${HUNT_FLAG} ${slice.q}`,
    1,
    slice.from,
    slice.to,
  );
  await waitForProbeOverlay(slice.from, slice.to);

  const manifest: HuntManifest = {
    q: slice.q,
    from: slice.from,
    to: slice.to,
    markId: slice.mark.id,
    markLabel: formatChangeMarkLabel(slice.mark),
    ui: UI_URL,
  };
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  const huntUrl = `${UI_URL}/?${new URLSearchParams({
    q: slice.q,
    range: "custom",
    from: slice.from,
    to: slice.to,
    cols: HUNT_ROW_COLS,
    metric: HUNT_PROBE_METRIC,
    ml: HUNT_PROBE_ML,
  }).toString()}`;
  console.log(
    `billing errors ${slice.billingErrorBefore} → ${slice.billingErrorAfter} (search total ${billing})`,
  );
  console.log(`manifest ${MANIFEST}`);
  console.log(huntUrl);
}

await main();
