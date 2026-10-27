import { ensureFullSeqProjection, ensureSeqProjection, type FeedKind } from "../feed/feed";

/**
 * The kinds a link carries (#329), as an operator ticks them: a key carries the set, all ticked
 * by default; the side rows leave from decides, and the side that pastes cannot widen it. Each
 * maps onto the feed's kinds (metrics are points and histogram buckets).
 */
export const linkKinds = ["logs", "marks", "traces", "metrics", "profiles", "monitors"] as const;
export type LinkKind = (typeof linkKinds)[number];

const feedKindsOf: Record<LinkKind, readonly FeedKind[]> = {
  logs: ["logs"],
  marks: ["marks"],
  traces: ["spans"],
  metrics: ["metrics", "metric_buckets"],
  profiles: ["profile_samples"],
  monitors: ["monitor_results"],
};

export function linkKindOfFeed(kind: FeedKind): LinkKind {
  return (Object.keys(feedKindsOf) as LinkKind[]).find((k) => feedKindsOf[k].includes(kind))!;
}

/** Stored and carried as `logs,marks,traces`. */
export function parseLinkKinds(raw: unknown): LinkKind[] | { error: string } {
  const list =
    raw === undefined || raw === null
      ? [...linkKinds]
      : Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",").map((k) => k.trim()).filter(Boolean)
          : null;
  if (!list) {
    return { error: "kinds is a list: logs, marks, traces, metrics, profiles, monitors" };
  }
  const bad = list.filter((k) => !(linkKinds as readonly unknown[]).includes(k));
  if (bad.length > 0) {
    return { error: `unknown kind: ${bad.join(", ")}` };
  }
  if (list.length === 0) {
    return { error: "a link carries at least one kind" };
  }
  // In the one order, without repeats.
  return linkKinds.filter((k) => list.includes(k));
}

export function kindsText(kinds: readonly LinkKind[]): string {
  return kinds.join(",");
}

export function kindsOf(text: string | null | undefined): LinkKind[] {
  const parsed = parseLinkKinds(text ?? "logs,marks");
  return "error" in parsed ? ["logs", "marks"] : parsed;
}

export function feedKinds(kinds: readonly LinkKind[]): FeedKind[] {
  return kinds.flatMap((k) => feedKindsOf[k]);
}

/**
 * Where rows leave this instance, each kind they carry needs reading by position (#324): the
 * logs projection, and a full projection ordered by seq for every other kind. Built once.
 */
export async function ensureSourceProjections(kinds: readonly LinkKind[]): Promise<void> {
  for (const kind of feedKinds(kinds)) {
    if (kind === "logs") {
      await ensureSeqProjection();
    } else if (kind !== "marks") {
      await ensureFullSeqProjection(kind);
    }
  }
}
