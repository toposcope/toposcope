import type { LogEvent } from "./types";

function attrValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null || typeof value === "string") {
    return value === null ? "null" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function attrsKey(attrs: LogEvent["attrs"]): string {
  if (!attrs) {
    return "";
  }
  return Object.keys(attrs)
    .sort()
    .map((key) => `${key}\0${attrValue(attrs[key])}`)
    .join("\0");
}

export function eventKey(event: LogEvent): string {
  return `${event.ts}\0${event.service}\0${event.host ?? ""}\0${event.level}\0${event.message}\0${attrsKey(event.attrs)}`;
}

export function eventRowKeys(events: readonly LogEvent[]): string[] {
  const seen = new Map<string, number>();
  return events.map((event) => {
    const base = eventKey(event);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}\0#${n}`;
  });
}

export function indexOfEventKey(events: LogEvent[], key: string | null): number {
  if (!key) {
    return -1;
  }
  return events.findIndex((event) => eventKey(event) === key);
}
