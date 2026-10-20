import { compareVersions, parseVersion, type Release, type StoreSize, type VersionReply } from "../shared/releases";

/**
 * What the footer's version and its panel say (#201, frames 19b–19i), kept apart from the
 * popover so each piece can be tested.
 */

/** Releases up to this one kept their upgrade notes in docs/operations.md, not back-filled (#199). */
const lastBeforeConvention = parseVersion("0.6.0")!;

export const operationsGuideUrl = "https://github.com/toposcope/toposcope/blob/main/docs/operations.md#upgrade-and-retention";
export const releasesPageUrl = "https://github.com/toposcope/toposcope/releases";

export type Chip = {
  running: string;
  /** The newer version, when one is known. */
  newer: string | null;
  /** A release in between carries a Before you upgrade (19d). */
  readFirst: boolean;
  label: string;
};

/** The footer item: the bare version, or `running → latest`, with a dot to read first. */
export function versionChip(reply: VersionReply): Chip {
  const newer = reply.releases.length > 0 && reply.latest !== reply.running ? reply.latest : null;
  const readFirst = newer !== null && reply.releases.some((r) => r.before_you_upgrade !== null);
  const label = newer
    ? `Toposcope ${reply.running}, ${newer} is out${readFirst ? ", read before upgrading" : ""}`
    : reply.check === "on" && reply.checked_at && !reply.error
      ? `Toposcope ${reply.running}, up to date`
      : `Toposcope ${reply.running}`;
  return { running: reply.running, newer, readFirst, label };
}

export type Segment = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "link"; text: string; href: string };

/** Release notes as paragraphs of plain text, `inline code` and [links](https://…); nothing else. */
export function noteParagraphs(notes: string): Segment[][] {
  return notes
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((p) => {
      const out: Segment[] = [];
      const re = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
      let at = 0;
      for (let m = re.exec(p); m; m = re.exec(p)) {
        if (m.index > at) out.push({ kind: "text", text: p.slice(at, m.index) });
        out.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "link", text: m[2]!, href: m[3]! });
        at = m.index + m[0].length;
      }
      if (at < p.length) out.push({ kind: "text", text: p.slice(at) });
      return out.map((s) => (s.kind === "text" ? { ...s, text: s.text.replace(/\*\*([^*]+)\*\*/g, "$1") } : s));
    });
}

/** A release's notes on one line (19e): the first paragraph as plain text. */
export function firstLine(notes: string): string {
  const [first] = noteParagraphs(notes);
  return first ? first.map((s) => s.text).join("") : "";
}

export type BeforeItem = { version: string; text: string | null; guide: boolean };

/**
 * Before you upgrade, all together (19e): each release's own paragraph, newest first. A release
 * up to 0.6.0 has none, as its notes stayed in the operations guide, so it links there; a later
 * one without a paragraph has nothing to say and is left out. Empty when nothing is to be read.
 */
export function beforeItems(releases: Release[]): BeforeItem[] {
  if (!releases.some((r) => r.before_you_upgrade !== null)) {
    return [];
  }
  return releases.flatMap((r): BeforeItem[] => {
    if (r.before_you_upgrade !== null) return [{ version: r.version, text: r.before_you_upgrade, guide: false }];
    const v = parseVersion(r.version);
    return v && compareVersions(v, lastBeforeConvention) <= 0 ? [{ version: r.version, text: null, guide: true }] : [];
  });
}

/** Exactly what Copy puts on the clipboard (19f): no prompt sign, no newline, a version never "latest". */
export function upgradeCommand(version: string): string {
  return `./upgrade.sh ${version}`;
}

/** Sizes as the panel writes them (19c): 1.16 GB, 41 MB; the total to one decimal, 1.2 GB. */
export function spelledBytes(n: number, total = false): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 ? 0 : total ? (v < 10 ? 1 : 0) : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${Number(v.toFixed(digits))} ${units[u]}`;
}

/** How big the backup the upgrade takes first will be, from the stores' own sizes. */
export function backupSize(store: StoreSize | null | undefined): string | null {
  const ch = store?.clickhouse_bytes ?? null;
  const sqlite = store?.sqlite_bytes ?? null;
  if (ch === null && sqlite === null) {
    return null;
  }
  const parts = [ch !== null ? `ClickHouse ${spelledBytes(ch)}` : null, sqlite !== null ? `SQLite ${spelledBytes(sqlite)}` : null].filter(Boolean);
  return `about ${spelledBytes((ch ?? 0) + (sqlite ?? 0), true)} (${parts.join(", ")})`;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `20 Oct`, or `20 Oct 2026` when asked for the year. */
export function dayLabel(iso: string | null, withYear = false): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ""}`;
}

/** `3 hours ago`, `5 minutes ago`, `just now`; a day or more reads as the date. */
export function agoLabel(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `on ${dayLabel(iso)}`;
}
