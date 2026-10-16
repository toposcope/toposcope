import { seriesLabel } from "../query/agg";

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

export function alertWebhookBody(args: {
  url: string;
  alert: { id: string; name: string; threshold: number };
  count: number;
  value: number;
  agg: string | null;
  query: string;
  firedAt: string;
  /** Back to Toposcope, when it knows its address (`TOPOSCOPE_PUBLIC_URL`). */
  link?: string | null;
}): unknown {
  const series = seriesLabel(args.agg);
  if (isSlackIncomingUrl(args.url)) {
    const open = args.link ? `\n<${args.link}|Open in Toposcope>` : "";
    return {
      text: `Toposcope: ${args.alert.name} — ${series} ${args.value} ≥ ${args.alert.threshold}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${args.alert.name}* fired\n\`${args.query || "*"}\`\n*${series}* ${args.value} ≥ ${args.alert.threshold}${open}`,
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

/** One call per mark and minute, listing every fingerprint new in it: ten, and a count of the rest. */
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
