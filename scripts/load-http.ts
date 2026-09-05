import { encodeLoadBatch, type EncodedLoadBatch } from "./load-encode";

export type LoadHttpEnv = {
  url: string;
  token: string;
};

/** Ingest insert slots are 32; leave some for the UI. */
export const LIVE_HTTP_IN_FLIGHT = 24;

let httpActive = 0;
const httpWait: Array<() => void> = [];

async function withHttpSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (httpActive >= LIVE_HTTP_IN_FLIGHT) {
    await new Promise<void>((resolve) => {
      httpWait.push(resolve);
    });
  }
  httpActive += 1;
  try {
    return await fn();
  } finally {
    httpActive -= 1;
    httpWait.shift()?.();
  }
}

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const sec = Number(retryAfter.trim());
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.min(30_000, sec * 1000);
    }
  }
  return 250 * (attempt + 1);
}

async function postJson(
  env: LoadHttpEnv,
  path: string,
  contentType: string,
  body: string | Uint8Array,
): Promise<number> {
  return withHttpSlot(async () => {
    let last = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(`${env.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          authorization: `Bearer ${env.token}`,
        },
        body: typeof body === "string" ? body : Buffer.from(body),
      });
      if (res.status === 429 || res.status === 503) {
        last = `${res.status} ${await res.text()}`;
        await Bun.sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
        continue;
      }
      if (!res.ok) {
        throw new Error(`ingest ${path} failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { ingested: number };
      return json.ingested;
    }
    throw new Error(`ingest ${path} still busy after retries: ${last}`);
  });
}

export async function postIngest(
  env: LoadHttpEnv,
  path: "/api/ingest" | "/v1/logs",
  contentType: string,
  body: string | Uint8Array,
): Promise<number> {
  return postJson(env, path, contentType, body);
}

export async function postMetrics(
  env: LoadHttpEnv,
  points: Array<{
    name: string;
    value: number;
    ts: string;
    labels?: Record<string, string>;
  }>,
): Promise<number> {
  return postJson(env, "/v1/metrics", "application/json", JSON.stringify(points));
}

export async function postMarks(
  env: LoadHttpEnv,
  marks: Array<{
    kind: string;
    title: string;
    id?: string;
    ts?: string;
    service?: string;
    attrs?: Record<string, string>;
  }>,
): Promise<number> {
  return postJson(env, "/v1/marks", "application/json", JSON.stringify(marks));
}

export async function postTraces(
  env: LoadHttpEnv,
  body: string | Uint8Array,
  proto: boolean,
): Promise<number> {
  return postJson(
    env,
    "/v1/traces",
    proto ? "application/x-protobuf" : "application/json",
    body,
  );
}

export async function sendEncoded(
  env: LoadHttpEnv,
  encoded: EncodedLoadBatch,
  udp: { send: (data: string, port: number, address: string) => unknown },
  syslog: { host: string; port: number },
): Promise<number> {
  if (encoded.transport === "udp") {
    for (const datagram of encoded.datagrams) {
      udp.send(datagram, syslog.port, syslog.host);
    }
    return encoded.datagrams.length;
  }
  return postIngest(env, encoded.path, encoded.contentType, encoded.body);
}

export { encodeLoadBatch };
