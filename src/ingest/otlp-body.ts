import type { Context } from "hono";
import { promisify } from "node:util";
import { gunzip as zlibGunzip } from "node:zlib";
import { MAX_BODY_BYTES } from "./index";

const gunzip = promisify(zlibGunzip);

export class BodyTooLargeError extends Error {
  readonly seenBytes: number;

  constructor(seenBytes: number, maxBytes: number) {
    super(`Body too large (max ${maxBytes} bytes)`);
    this.name = "BodyTooLargeError";
    this.seenBytes = seenBytes;
  }
}

export class InvalidGzipError extends Error {
  constructor() {
    super("Invalid gzip body");
    this.name = "InvalidGzipError";
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) {
      await reader.cancel().catch(() => undefined);
    }
    throw err;
  }
  return concatBytes(chunks, total);
}

export async function gunzipCapped(
  compressed: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  let out: Buffer;
  try {
    out = await gunzip(compressed, { maxOutputLength: maxBytes });
  } catch (err) {
    if (errorCode(err) === "ERR_BUFFER_TOO_LARGE") {
      throw new BodyTooLargeError(maxBytes, maxBytes);
    }
    throw new InvalidGzipError();
  }
  if (out.byteLength > maxBytes) {
    throw new BodyTooLargeError(out.byteLength, maxBytes);
  }
  return Uint8Array.from(out);
}

export async function readOtlpBody(c: Context): Promise<Uint8Array | Response> {
  try {
    const raw = await readCappedBytes(c.req.raw.body, MAX_BODY_BYTES);
    if (c.req.header("content-encoding") === "gzip") {
      return await gunzipCapped(raw, MAX_BODY_BYTES);
    }
    return raw;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return c.json({ error: err.message }, 413);
    }
    if (err instanceof InvalidGzipError) {
      return c.json({ error: "Invalid gzip body" }, 400);
    }
    throw err;
  }
}
