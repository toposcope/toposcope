/**
 * Snappy's block format, the compression Prometheus remote write uses: a
 * varint length, then literals and copies of what came before. Not the framed
 * format. Written here because it is a page of code and a dependency is not.
 */

export class InvalidSnappyError extends Error {
  constructor(message = "Invalid snappy body") {
    super(message);
    this.name = "InvalidSnappyError";
  }
}

export class SnappyTooLargeError extends Error {
  constructor(readonly length: number, maxBytes: number) {
    super(`Body too large (max ${maxBytes} bytes)`);
    this.name = "SnappyTooLargeError";
  }
}

/** The length the block says it holds, and where its elements start. */
function header(src: Uint8Array): { length: number; at: number } {
  let length = 0;
  let shift = 0;
  for (let at = 0; at < src.length && at < 5; at++) {
    const byte = src[at]!;
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { length, at: at + 1 };
    }
    shift += 7;
  }
  throw new InvalidSnappyError();
}

/** Decompress one block. Refuses one that says it holds more than `maxBytes` before it starts. */
export function snappyDecompress(src: Uint8Array, maxBytes: number): Uint8Array {
  const { length, at: start } = header(src);
  if (length > maxBytes) {
    throw new SnappyTooLargeError(length, maxBytes);
  }
  const out = new Uint8Array(length);
  let o = 0;
  let i = start;
  while (i < src.length) {
    const tag = src[i++]!;
    let len: number;
    let offset = 0;
    switch (tag & 3) {
      case 0: {
        len = tag >>> 2;
        if (len >= 60) {
          const bytes = len - 59;
          if (i + bytes > src.length) throw new InvalidSnappyError();
          len = 0;
          for (let b = 0; b < bytes; b++) len += src[i + b]! * 2 ** (8 * b);
          i += bytes;
        }
        len += 1;
        if (i + len > src.length || o + len > length) throw new InvalidSnappyError();
        out.set(src.subarray(i, i + len), o);
        i += len;
        o += len;
        continue;
      }
      case 1:
        if (i >= src.length) throw new InvalidSnappyError();
        len = ((tag >>> 2) & 7) + 4;
        offset = ((tag >>> 5) << 8) | src[i++]!;
        break;
      case 2:
        if (i + 2 > src.length) throw new InvalidSnappyError();
        len = (tag >>> 2) + 1;
        offset = src[i]! | (src[i + 1]! << 8);
        i += 2;
        break;
      default:
        if (i + 4 > src.length) throw new InvalidSnappyError();
        len = (tag >>> 2) + 1;
        offset = (src[i]! | (src[i + 1]! << 8) | (src[i + 2]! << 16)) + src[i + 3]! * 2 ** 24;
        i += 4;
    }
    if (offset === 0 || offset > o || o + len > length) throw new InvalidSnappyError();
    // A copy may overlap what it writes: byte by byte repeats the run.
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset]!;
  }
  if (o !== length) throw new InvalidSnappyError();
  return out;
}

/** Literals only: valid snappy that any reader takes. For tests and for sending a fixture back. */
export function snappyCompressLiterals(src: Uint8Array): Uint8Array {
  const parts: number[] = [];
  let n = src.length;
  do {
    parts.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  for (let i = 0; i < src.length; i += 65_536) {
    const chunk = src.subarray(i, i + 65_536);
    const len = chunk.length - 1;
    if (len < 60) {
      parts.push(len << 2);
    } else if (len < 256) {
      parts.push(60 << 2, len);
    } else {
      parts.push(61 << 2, len & 0xff, len >>> 8);
    }
    for (const byte of chunk) parts.push(byte);
  }
  return Uint8Array.from(parts);
}
