const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type LoadProfileId = "10k" | "500k" | "10m" | "100m";

export type LoadProfile = {
  id: LoadProfileId;
  n: number;
  range: "1h" | "24h" | "7d";
  windowMs: number;
  ingestConcurrency: number;
  /** Empty / level / histogram-style queries. */
  mvMs: number;
  /** Message substring and facets (scan logs). */
  scanMs: number;
  /** 100m is generated inside ClickHouse; smaller profiles mix ingest paths. */
  via: "http" | "clickhouse";
  /** 100m skips message/facet scans (full table). */
  smoke: "all" | "mv";
};

export const loadProfiles: Record<LoadProfileId, LoadProfile> = {
  "10k": {
    id: "10k",
    n: 10_000,
    range: "1h",
    windowMs: HOUR_MS,
    ingestConcurrency: 1,
    mvMs: 1000,
    scanMs: 1000,
    via: "http",
    smoke: "all",
  },
  "500k": {
    id: "500k",
    n: 500_000,
    range: "24h",
    windowMs: DAY_MS,
    ingestConcurrency: 4,
    mvMs: 1000,
    scanMs: 3000,
    via: "http",
    smoke: "all",
  },
  "10m": {
    id: "10m",
    n: 10_000_000,
    range: "7d",
    windowMs: 7 * DAY_MS,
    ingestConcurrency: 8,
    mvMs: 2000,
    scanMs: 15_000,
    via: "http",
    smoke: "all",
  },
  "100m": {
    id: "100m",
    n: 100_000_000,
    range: "7d",
    windowMs: 7 * DAY_MS,
    ingestConcurrency: 1,
    mvMs: 30_000,
    scanMs: 60_000,
    via: "clickhouse",
    smoke: "mv",
  },
};

const aliases: Record<string, LoadProfileId> = {
  "10k": "10k",
  "10000": "10k",
  smoke: "10k",
  "500k": "500k",
  "500000": "500k",
  "10m": "10m",
  "10M": "10m",
  "10000000": "10m",
  "100m": "100m",
  "100M": "100m",
  "100000000": "100m",
};

export function parseLoadProfile(raw: string | undefined): LoadProfile {
  const key = (raw ?? "10k").trim();
  const id = aliases[key];
  if (!id) {
    throw new Error(
      `Unknown load profile "${key}". Use 10k, 500k, 10m, or 100m.`,
    );
  }
  return loadProfiles[id];
}
