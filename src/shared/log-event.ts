import * as v from "valibot";

export const levels = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof levels)[number];

export type LogEvent = {
  ts: string;
  service: string;
  host?: string;
  level: LogLevel;
  message: string;
  attrs?: Record<string, unknown>;
};

export const logEventSchema = v.object({
  ts: v.string(),
  service: v.pipe(v.string(), v.minLength(1)),
  host: v.optional(v.string()),
  level: v.picklist(levels),
  message: v.string(),
  attrs: v.optional(v.record(v.string(), v.unknown())),
});

export const ingestEventSchema = v.object({
  ts: v.optional(v.string()),
  service: v.pipe(v.string(), v.minLength(1)),
  host: v.optional(v.string()),
  level: v.picklist(levels),
  message: v.string(),
  attrs: v.optional(v.record(v.string(), v.unknown())),
});

export type IngestEvent = v.InferOutput<typeof ingestEventSchema>;

export function parseLogEvent(input: unknown): LogEvent {
  return v.parse(logEventSchema, input);
}

export function parseIngestEvent(input: unknown): IngestEvent {
  return v.parse(ingestEventSchema, input);
}

export function stampEvent(event: IngestEvent): LogEvent {
  return {
    ts: event.ts && !Number.isNaN(Date.parse(event.ts))
      ? new Date(event.ts).toISOString()
      : new Date().toISOString(),
    service: event.service,
    host: event.host,
    level: event.level,
    message: event.message,
    attrs: event.attrs,
  };
}
