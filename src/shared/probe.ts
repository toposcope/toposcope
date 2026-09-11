import { isMetricIdent, type MetricPoint } from "./metric";

export const probeMetricName = "up";
export const maxProbes = 500;
export const probePullTimeoutMs = 5_000;
export const maxProbeCheck = 64;
export const maxProbeTarget = 2_000;

export type ProbeUp = 0 | 1;
export type ProbeSource = "attach" | "pull";

export type ProbeSample = {
  ts: string;
  service: string;
  host: string;
  check: string;
  target: string;
  up: ProbeUp;
  source: ProbeSource;
};

export type ParsedProbeRequest =
  | { mode: "attach"; sample: ProbeSample }
  | { mode: "pull"; sample: ProbeSample };

export class InvalidProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProbeError";
  }
}

export function parseProbeUp(raw: unknown): ProbeUp {
  if (raw === 0) {
    return 0;
  }
  if (raw === 1) {
    return 1;
  }
  throw new InvalidProbeError("up must be 0 or 1");
}

export function upFromHttpOk(ok: boolean): ProbeUp {
  return ok ? 1 : 0;
}

export function parseProbeUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InvalidProbeError("url must be an http(s) URL");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxProbeTarget) {
    throw new InvalidProbeError("url must be an http(s) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidProbeError("url must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidProbeError("url must be an http(s) URL");
  }
  if (!parsed.hostname) {
    throw new InvalidProbeError("url must be an http(s) URL");
  }
  return parsed.toString();
}

export async function pullProbeUp(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeUp> {
  try {
    const res = await fetchImpl(target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(probePullTimeoutMs),
    });
    return upFromHttpOk(res.ok);
  } catch {
    return 0;
  }
}

function parseOptionalTs(raw: unknown): string {
  if (raw == null || raw === "") {
    return new Date().toISOString();
  }
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new InvalidProbeError("ts must be an ISO timestamp");
  }
  return new Date(raw).toISOString();
}

function parseService(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InvalidProbeError("service is required");
  }
  const service = raw.trim();
  if (service.length === 0) {
    throw new InvalidProbeError("service is required");
  }
  return service;
}

function parseOptionalLabel(
  raw: unknown,
  field: string,
  max: number,
): string {
  if (raw == null || raw === "") {
    return "";
  }
  if (typeof raw !== "string") {
    throw new InvalidProbeError(`${field} must be a string`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    return "";
  }
  if (value.length > max) {
    throw new InvalidProbeError(`${field} is too long`);
  }
  if (field === "check" && !isMetricIdent(value)) {
    throw new InvalidProbeError("check must be an ident");
  }
  return value;
}

/**
 * Attach `{ service, up: 0|1 }` or pull one `{ service, url }`.
 * `up` present means attach (url is stored, not fetched). Array ingest is attach-only.
 */
export function parseProbeRequest(
  input: unknown,
  opts: { pullAllowed: boolean },
): ParsedProbeRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidProbeError("Invalid probe");
  }
  const rec = input as Record<string, unknown>;
  const service = parseService(rec.service);
  const ts = parseOptionalTs(rec.ts);
  const host = parseOptionalLabel(rec.host, "host", 256);
  const check = parseOptionalLabel(rec.check, "check", maxProbeCheck);
  const hasUp = rec.up !== undefined && rec.up !== null;
  const hasUrl = rec.url !== undefined && rec.url !== null && rec.url !== "";

  if (hasUp) {
    const target = hasUrl ? parseProbeUrl(rec.url) : "";
    return {
      mode: "attach",
      sample: {
        ts,
        service,
        host,
        check,
        target,
        up: parseProbeUp(rec.up),
        source: "attach",
      },
    };
  }
  if (!opts.pullAllowed) {
    throw new InvalidProbeError("up must be 0 or 1");
  }
  if (!hasUrl) {
    throw new InvalidProbeError("up must be 0 or 1, or url to pull");
  }
  const target = parseProbeUrl(rec.url);
  return {
    mode: "pull",
    sample: {
      ts,
      service,
      host,
      check,
      target,
      up: 0,
      source: "pull",
    },
  };
}

export function probeToMetricPoint(sample: ProbeSample): MetricPoint {
  const labels: Record<string, string> = { service: sample.service };
  if (sample.host) {
    labels.host = sample.host;
  }
  if (sample.check) {
    labels.check = sample.check;
  }
  if (sample.target) {
    labels.target = sample.target;
  }
  labels.source = sample.source;
  return {
    ts: sample.ts,
    name: probeMetricName,
    value: sample.up,
    labels,
  };
}

export function metricValueToUp(value: number): ProbeUp {
  return value === 0 ? 0 : 1;
}

export function probesIngestBody(
  single: boolean,
  samples: ProbeSample[],
  ingested: number,
): { ingested: number; up?: ProbeUp } {
  if (single) {
    const up = samples[0]?.up;
    return up === undefined ? { ingested } : { ingested, up };
  }
  return { ingested };
}
