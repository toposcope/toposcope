import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { MAX_BODY_BYTES } from "./index";
import {
  BodyTooLargeError,
  InvalidGzipError,
  gunzipCapped,
  readCappedBytes,
} from "./otlp-body";
import { otlpLogsRoute } from "./otlp-route";
import { otlpProfilesRoute } from "./otlp-profiles-route";
import { otlpTracesRoute } from "./otlp-traces-route";

const EXPAND_PAST_CAP = 8 * 1024 * 1024;

function gzipZeros(byteLength: number): Buffer {
  return gzipSync(Buffer.alloc(byteLength));
}

describe("gunzipCapped", () => {
  test("round-trips gzip under the cap", async () => {
    const plain = Buffer.from('{"resourceLogs":[]}');
    const out = await gunzipCapped(gzipSync(plain), MAX_BODY_BYTES);
    expect(Buffer.from(out).toString()).toBe(plain.toString());
  });

  test("accepts gzip that expands to exactly maxBytes", async () => {
    const out = await gunzipCapped(gzipZeros(1_000), 1_000);
    expect(out.byteLength).toBe(1_000);
  });

  test("gzip that would expand past maxBytes fails without holding the expanded payload", async () => {
    const compressed = gzipZeros(EXPAND_PAST_CAP);
    expect(compressed.byteLength).toBeLessThan(16_384);
    try {
      await gunzipCapped(compressed, MAX_BODY_BYTES);
      throw new Error("expected BodyTooLargeError");
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
      expect((err as BodyTooLargeError).seenBytes).toBeLessThanOrEqual(
        MAX_BODY_BYTES,
      );
    }
  });

  test("malformed gzip is invalid, not too large", async () => {
    await expect(gunzipCapped(Buffer.from("not-gzip"), 1_000)).rejects.toBeInstanceOf(
      InvalidGzipError,
    );
  });
});

describe("readCappedBytes", () => {
  test("stops reading once the wire body exceeds maxBytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(300));
        controller.close();
      },
    });
    try {
      await readCappedBytes(body, 1_000);
      throw new Error("expected BodyTooLargeError");
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
    }
  });
});

describe("OTLP gzip routes", () => {
  const app = new Hono();
  app.post("/v1/logs", otlpLogsRoute);
  app.post("/v1/traces", otlpTracesRoute);
  app.post("/v1/profiles", otlpProfilesRoute);

  const paths = ["/v1/logs", "/v1/traces", "/v1/profiles"] as const;

  for (const path of paths) {
    test(`${path} rejects gzip that expands past 1MB`, async () => {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
        body: Uint8Array.from(gzipZeros(EXPAND_PAST_CAP)).buffer,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: `Body too large (max ${MAX_BODY_BYTES} bytes)`,
      });
    });

    test(`${path} rejects malformed gzip with 400`, async () => {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
        body: "not-gzip",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid gzip body" });
    });
  }
});
