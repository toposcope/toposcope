export {};

import { fakeLogEvent } from "./shared/fake-event";
import { envValue } from "./shared/env";

const APP_URL = envValue("TOPOSCOPE_URL") ?? "http://127.0.0.1:8080";
const INGEST_TOKEN = envValue("TOPOSCOPE_INGEST_TOKEN") ?? "toposcope-ingest";

async function main(): Promise<void> {
  const n = 200;
  const now = Date.now();
  const events = Array.from({ length: n }, (_, i) =>
    fakeLogEvent({ i, n, now, windowMs: 60 * 60 * 1000, marker: "seed" }),
  );

  for (let i = 0; i < events.length; i += 100) {
    const batch = events.slice(i, i + 100);
    const res = await fetch(`${APP_URL}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`seed ingest failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { ingested: number };
    console.log(`ingested ${json.ingested}`);
  }
}

await main();
