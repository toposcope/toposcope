/** Releases as `GET /api/version` gives them (#196), shared by the server and the footer (#201). */

export type Release = {
  version: string;
  published_at: string | null;
  url: string | null;
  /** The release body, without its Before you upgrade paragraph. */
  notes: string;
  /** The paragraph that starts `**Before you upgrade:**`, without that lead; null when it has none. */
  before_you_upgrade: string | null;
};

export type Step = "patch" | "minor" | "major";

/** How big the stores are, for the backup an upgrade takes first (#201). */
export type StoreSize = { clickhouse_bytes: number | null; sqlite_bytes: number | null };

export type VersionReply = {
  running: string;
  /** The newest release known, or the running version when none is newer. */
  latest: string;
  /** How far `latest` is from `running`; null when nothing newer is known. */
  step: Step | null;
  check: "on" | "off";
  checked_at: string | null;
  error: string | null;
  releases: Release[];
  /** Given only while a newer release is known: the footer's panel says how big the backup is. */
  store?: StoreSize;
};

export type Semver = [number, number, number];

export function parseVersion(raw: string): Semver | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Before 1.0 the middle number is the minor step (0.6 → 0.7); 0.x → 1.0 is major. */
export function releaseStep(running: string, latest: string): Step | null {
  const a = parseVersion(running);
  const b = parseVersion(latest);
  if (!a || !b || compareVersions(b, a) <= 0) {
    return null;
  }
  if (b[0] !== a[0]) {
    return "major";
  }
  return b[1] !== a[1] ? "minor" : "patch";
}
