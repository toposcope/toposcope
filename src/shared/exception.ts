/** At most 50 frames — same cap fingerprints will hash. */
export const maxExceptionFrames = 50;

export type ExceptionFrame = {
  file: string;
  function: string;
  in_app?: boolean;
};

function str(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function frameFrom(raw: unknown): ExceptionFrame | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const file = str(row.file) ?? str(row.filename) ?? "";
  const fn = str(row.function) ?? str(row.fn) ?? "";
  if (!file && !fn) {
    return undefined;
  }
  const frame: ExceptionFrame = { file, function: fn };
  const inApp = row.in_app ?? row.inApp;
  if (typeof inApp === "boolean") {
    frame.in_app = inApp;
  }
  return frame;
}

export function parseExceptionFrames(raw: unknown): ExceptionFrame[] {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const frames: ExceptionFrame[] = [];
  for (const item of value) {
    const frame = frameFrom(item);
    if (frame) {
      frames.push(frame);
    }
    if (frames.length >= maxExceptionFrames) {
      break;
    }
  }
  return frames;
}

/**
 * Lift exception.type / exception.frames to top-level attrs when the sender
 * already structured them (app, OTEL, or a collector remap).
 * Does not parse `message` or `exception.stacktrace`.
 */
export function liftException(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attrs) {
    return attrs;
  }
  const next: Record<string, unknown> = { ...attrs };
  const nested = next.exception;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const obj = nested as Record<string, unknown>;
    if (next["exception.type"] === undefined && str(obj.type)) {
      next["exception.type"] = str(obj.type);
    }
    if (next["exception.message"] === undefined && str(obj.message)) {
      next["exception.message"] = str(obj.message);
    }
    if (next["exception.stacktrace"] === undefined && str(obj.stacktrace)) {
      next["exception.stacktrace"] = str(obj.stacktrace);
    }
    if (next["exception.frames"] === undefined && obj.frames !== undefined) {
      next["exception.frames"] = obj.frames;
    }
    delete next.exception;
  }

  if (typeof next["exception.type"] === "string") {
    const type = str(next["exception.type"]);
    if (type) {
      next["exception.type"] = type;
    } else {
      delete next["exception.type"];
    }
  }

  const frames = parseExceptionFrames(next["exception.frames"]);
  if (frames.length > 0) {
    next["exception.frames"] = frames;
  } else {
    delete next["exception.frames"];
  }

  return Object.keys(next).length > 0 ? next : undefined;
}
