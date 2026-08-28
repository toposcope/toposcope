import { createHash } from "node:crypto";
import { parseExceptionFrames, type ExceptionFrame } from "./exception";
import type { LogLevel } from "./log-event";
import { fingerprintAttr, fingerprintHexLength } from "./fingerprint-attr";

export { fingerprintAttr, fingerprintHexLength };

function hashParts(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, fingerprintHexLength);
}

function typeOf(attrs: Record<string, unknown> | undefined): string {
  const raw = attrs?.["exception.type"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function framesForHash(frames: ExceptionFrame[]): ExceptionFrame[] {
  const inApp = frames.filter((frame) => frame.in_app === true);
  return inApp.length > 0 ? inApp : frames;
}

/**
 * Fold ids, IPs, timestamps, and digit runs so the same bug hashes together.
 * Does not parse stacks — that is `liftException`.
 */
export function stabilizeMessage(message: string): string {
  return message
    .replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      "#",
    )
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, "#")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "#")
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
      "#",
    )
    .replace(/\b[0-9a-fA-F]{16,}\b/g, "#")
    .replace(/\b\d+\b/g, "#");
}

export function computeFingerprint(
  level: LogLevel,
  message: string,
  attrs: Record<string, unknown> | undefined,
): string | undefined {
  const type = typeOf(attrs);
  const frames = parseExceptionFrames(attrs?.["exception.frames"]);
  if (frames.length > 0) {
    const used = framesForHash(frames);
    return hashParts([
      type,
      ...used.flatMap((frame) => [frame.file.toLowerCase(), frame.function.toLowerCase()]),
    ]);
  }
  if (type.length > 0 || level === "error" || level === "fatal") {
    return hashParts([type, stabilizeMessage(message).toLowerCase()]);
  }
  return undefined;
}

/** Stamp `e1` first so the 50-key flatten cap cannot drop it. Replaces a sender `e1`. */
export function withFingerprint(
  level: LogLevel,
  message: string,
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(attrs ?? {}) };
  delete next.e1;
  delete next.E1;
  const hex = computeFingerprint(level, message, next);
  if (!hex) {
    return Object.keys(next).length > 0 ? next : undefined;
  }
  return { [fingerprintAttr]: hex, ...next };
}
