import { seriesLabel } from "../query/agg";
import {
  alertBodyContentType,
  fillAlertBody,
  type AlertBodyKind,
} from "../shared/alert-body";
import type { OpensWhen } from "../shared/monitor";

export const silenceForIds = ["1h", "4h", "24h"] as const;
export type SilenceForId = (typeof silenceForIds)[number];

const silenceForMs: Record<SilenceForId, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export function parseSilenceFor(value: unknown): SilenceForId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if ((silenceForIds as readonly string[]).includes(value)) {
    return value as SilenceForId;
  }
  return undefined;
}

export function silencedUntilFrom(now: number, forId: SilenceForId): number {
  return now + silenceForMs[forId];
}

export function isSlackIncomingUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "hooks.slack.com" || host.endsWith(".hooks.slack.com");
  } catch {
    return false;
  }
}

/**
 * The saved search over the window that fired, at the address Toposcope is
 * opened at: its `q`, the window as a custom range (so it reads the same
 * whenever it is opened), its series, and the saved search it came from.
 */
export function alertLink(
  base: string,
  fired: {
    savedId: string;
    query: string;
    agg: string | null;
    from: string;
    to: string;
    /** A first-seen call opens that mark's Fingerprints, cut at `to`. */
    cut?: string;
  },
): string {
  const params = new URLSearchParams();
  if (fired.query.trim()) {
    params.set("q", fired.query.trim());
  }
  params.set("range", "custom");
  params.set("from", fired.from);
  params.set("to", fired.to);
  if (fired.agg) {
    params.set("agg", fired.agg);
  }
  params.set("saved", fired.savedId);
  if (fired.cut) {
    params.set("cut", fired.cut);
  }
  return `${base}/?${params.toString()}`;
}

/** Which call this is (#175): it opened, it is still open, or it resolved. */
export type CallState = "open" | "reminder" | "resolved";

/** A call's place in its stretch: when it opened, when it resolved, and how long that is. */
export type StretchCall = {
  state: CallState;
  openedAt: string;
  resolvedAt: string | null;
  /** "22m", "7h 59m": open so far, or how long it lasted. */
  duration: string;
};

export function alertWebhookBody(args: {
  url: string;
  /** `opens_when` only for a monitor that opens on fewer than its threshold (#176). */
  alert: { id: string; name: string; threshold: number; opens_when?: OpensWhen };
  count: number;
  value: number;
  agg: string | null;
  query: string;
  firedAt: string;
  /** Back to Toposcope, when it knows its address (`TOPOSCOPE_PUBLIC_URL`). */
  link?: string | null;
  /** A monitor's call; without one the body is 0.5's. */
  call?: StretchCall | null;
}): unknown {
  const series = seriesLabel(args.agg);
  const call = args.call ?? null;
  if (isSlackIncomingUrl(args.url)) {
    const open = args.link ? `\n<${args.link}|Open in Toposcope>` : "";
    // At least opens at ≥ and resolves at <; fewer than the other way round.
    const fewer = args.alert.opens_when === "fewer_than";
    const sign = (call?.state === "resolved") !== fewer ? "<" : "≥";
    const reading = `${series} ${args.value} ${sign} ${args.alert.threshold}`;
    const headline =
      call?.state === "resolved"
        ? `resolved after ${call.duration}`
        : call?.state === "reminder"
          ? `still open · ${call.duration}`
          : "fired";
    const text =
      call?.state === "resolved" || call?.state === "reminder"
        ? `Toposcope: ${args.alert.name} ${headline} — ${reading}`
        : `Toposcope: ${args.alert.name} — ${reading}`;
    return {
      text,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${args.alert.name}* ${headline}\n\`${args.query || "*"}\`\n*${series}* ${args.value} ${sign} ${args.alert.threshold}${open}`,
          },
        },
      ],
    };
  }
  return {
    alert: args.alert,
    count: args.count,
    value: args.value,
    agg: args.agg,
    query: args.query,
    fired_at: args.firedAt,
    ...(call ? { state: call.state, opened_at: call.openedAt, resolved_at: call.resolvedAt } : {}),
    ...(args.link ? { link: args.link } : {}),
  };
}

export type FirstSeenFingerprint = {
  e1: string;
  type: string;
  message: string;
  first_seen: string | null;
  events: number;
};

export type FirstSeenMark = {
  id: string;
  kind: string;
  service: string;
  title: string;
  ts: string;
};

/** "2 new fingerprints after deploy v0.9.3". */
export function firstSeenHeadline(count: number, mark: FirstSeenMark): string {
  return `${count} new fingerprint${count === 1 ? "" : "s"} after ${mark.kind} ${mark.title}`;
}

/** One call per mark and minute, listing the fingerprints it pages for: ten, and a count of the rest. */
export function firstSeenWebhookBody(args: {
  url: string;
  alert: { id: string; name: string; threshold: number };
  query: string;
  mark: FirstSeenMark;
  fingerprints: FirstSeenFingerprint[];
  more: number;
  firedAt: string;
  link?: string | null;
}): unknown {
  const count = args.fingerprints.length + args.more;
  if (isSlackIncomingUrl(args.url)) {
    const open = args.link ? `\n<${args.link}|Open in Toposcope>` : "";
    const headline = firstSeenHeadline(count, args.mark);
    return {
      text: `Toposcope: ${args.alert.name} — ${headline}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${args.alert.name}* fired\n\`${args.query || "*"}\`\n${headline}${open}`,
          },
        },
      ],
    };
  }
  return {
    alert: { ...args.alert, kind: "first_seen" },
    query: args.query,
    mark: args.mark,
    count,
    fingerprints: args.fingerprints,
    more: args.more,
    fired_at: args.firedAt,
    ...(args.link ? { link: args.link } : {}),
  };
}

/** A call as it goes on the wire. */
export type WebhookPayload = { body: string; contentType: string };

function plainNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6)));
}

/** Frame 15e's fill-ins for a threshold alert, and a monitor's `state` and stretch (#175). */
export function thresholdFillValues(args: {
  name: string;
  agg: string | null;
  value: number;
  threshold: number;
  query: string;
  firedAt: string;
  link: string | null;
  call?: StretchCall | null;
  /** The result that opened it. */
  message?: string;
}): Record<string, string> {
  return {
    "alert.name": args.name,
    series: seriesLabel(args.agg),
    value: plainNumber(args.value),
    threshold: plainNumber(args.threshold),
    query: args.query,
    fired_at: args.firedAt,
    link: args.link ?? "",
    state: args.call?.state ?? "open",
    opened_at: args.call?.openedAt ?? args.firedAt,
    resolved_at: args.call?.resolvedAt ?? "",
    duration: args.call?.duration ?? "0s",
    message: args.message ?? "",
  };
}

/**
 * "Count 57 ≥ 50", "p99(duration_ms) 412 < 800": a search monitor's result in words; "no line
 * for 15m" when a fewer-than count read none (#176, 18o).
 */
export function readingMessage(
  agg: string | null,
  value: number,
  threshold: number,
  opensWhen: OpensWhen = "at_least",
  range: string | null = null,
): string {
  if (opensWhen === "fewer_than" && !agg && value === 0 && range) {
    return `no line for ${range}`;
  }
  return `${seriesLabel(agg)} ${plainNumber(value)} ${value >= threshold ? "≥" : "<"} ${plainNumber(threshold)}`;
}

/** Frame 15f's fill-ins for a new-fingerprints alert. */
export function firstSeenFillValues(args: {
  name: string;
  query: string;
  mark: FirstSeenMark;
  fingerprints: FirstSeenFingerprint[];
  more: number;
  link: string | null;
}): Record<string, string> {
  const first = args.fingerprints[0];
  const line = (f: FirstSeenFingerprint) =>
    `${f.message || f.type} · e1:${f.e1} · ${f.events} event${f.events === 1 ? "" : "s"}`;
  return {
    "alert.name": args.name,
    query: args.query,
    "mark.kind": args.mark.kind,
    "mark.version": args.mark.title,
    "mark.at": args.mark.ts,
    "fingerprints.count": String(args.fingerprints.length + args.more),
    "fingerprints.first": first
      ? first.type && !first.message.startsWith(first.type)
        ? `${first.type}: ${first.message}`
        : first.message || first.type
      : "",
    fingerprints: args.fingerprints.map(line).join("\n"),
    more: args.more > 0 ? `and ${args.more} more` : "",
    link: args.link ?? "",
  };
}

/** Today's body as JSON, or the alert's own, filled in. */
export function renderWebhook(
  rule: { body_kind: AlertBodyKind; body_template: string | null },
  defaultBody: unknown,
  values: Record<string, string>,
): WebhookPayload {
  if (rule.body_kind === "default" || !rule.body_template) {
    return { body: JSON.stringify(defaultBody), contentType: "application/json" };
  }
  return {
    body: fillAlertBody(rule.body_template, values, rule.body_kind),
    contentType: alertBodyContentType(rule.body_kind),
  };
}

/**
 * Whether a monitor sends a resolved call: the default body (and Slack's) always does; a text or
 * JSON body of its own only with a resolved body, so a message written for "it fired" never
 * arrives when it ended.
 */
export function sendsResolved(rule: { body_kind: AlertBodyKind; body_template: string | null; resolved_body: string | null }): boolean {
  if (rule.body_kind === "default" || !rule.body_template) {
    return true;
  }
  return Boolean(rule.resolved_body && rule.resolved_body.trim());
}

/** The resolved call: the default body, or the resolved body in the body's kind. */
export function renderResolved(
  rule: { body_kind: AlertBodyKind; body_template: string | null; resolved_body: string | null },
  defaultBody: unknown,
  values: Record<string, string>,
): WebhookPayload | null {
  if (!sendsResolved(rule)) {
    return null;
  }
  if (rule.body_kind === "default" || !rule.body_template) {
    return renderWebhook(rule, defaultBody, values);
  }
  return renderWebhook({ body_kind: rule.body_kind, body_template: rule.resolved_body }, defaultBody, values);
}
