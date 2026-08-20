import type { LogEvent, LogLevel } from "../shared/log-event";

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function severityToLevel(severity: number): LogLevel {
  if (severity <= 2) {
    return "fatal";
  }
  if (severity === 3) {
    return "error";
  }
  if (severity === 4) {
    return "warn";
  }
  if (severity === 7) {
    return "debug";
  }
  return "info";
}

function parse3164Ts(stamp: string, now = new Date()): string | null {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!match) {
    return null;
  }
  const month = MONTHS[match[1] ?? ""];
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  if (month === undefined || Number.isNaN(day)) {
    return null;
  }
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), month, day, hour, minute, second),
  );
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

function levelToSeverity(level: LogLevel): number {
  switch (level) {
    case "fatal":
      return 2;
    case "error":
      return 3;
    case "warn":
      return 4;
    case "info":
      return 6;
    case "debug":
      return 7;
    default: {
      const _never: never = level;
      return _never;
    }
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** RFC 3164 datagram the parser accepts. Timestamp is UTC, seconds only. */
export function formatSyslog3164(event: LogEvent): string {
  const d = new Date(event.ts);
  const month = MONTH_NAMES[d.getUTCMonth()] ?? "Jan";
  const day = d.getUTCDate();
  const dayPart = day < 10 ? ` ${day}` : String(day);
  const stamp = `${month} ${dayPart} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const pri = 16 * 8 + levelToSeverity(event.level);
  const host = event.host && event.host.length > 0 ? event.host : "unknown";
  return `<${pri}>${stamp} ${host} ${event.service}: ${event.message}`;
}

export function parseSyslog3164(raw: string, now = new Date()): LogEvent | null {
  const text = raw.replace(/\u0000/g, "").trim();
  const match =
    /^<(\d{1,3})>([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:]+)(?::\s*|\s+)(.*)$/.exec(
      text,
    );
  if (!match) {
    return null;
  }
  const pri = Number(match[1]);
  if (!Number.isFinite(pri) || pri > 191) {
    return null;
  }
  const ts = parse3164Ts(match[2] ?? "", now);
  if (!ts) {
    return null;
  }
  const host = match[3];
  const tag = match[4] ?? "syslog";
  const message = (match[5] ?? "").trim();
  if (message.length === 0) {
    return null;
  }
  const severity = pri % 8;
  const service = tag.replace(/\[\d+\]$/, "");
  return {
    ts,
    service: service.length > 0 ? service : "syslog",
    host,
    level: severityToLevel(severity),
    message,
  };
}
