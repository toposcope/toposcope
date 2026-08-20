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

export function alertWebhookBody(args: {
  url: string;
  alert: { id: string; name: string; threshold: number };
  count: number;
  value: number;
  agg: string | null;
  query: string;
  firedAt: string;
}): unknown {
  const series = seriesLabel(args.agg);
  if (isSlackIncomingUrl(args.url)) {
    return {
      text: `Toposcope: ${args.alert.name} — ${series} ${args.value} ≥ ${args.alert.threshold}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${args.alert.name}* fired\n\`${args.query || "*"}\`\n*${series}* ${args.value} ≥ ${args.alert.threshold}`,
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
  };
}
