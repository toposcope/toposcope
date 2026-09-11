import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import {
  maxProbes,
  metricValueToUp,
  probeMetricName,
  type ProbeSample,
  type ProbeSource,
  type ProbeUp,
} from "../shared/probe";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";

type MetricRow = {
  ts: string;
  value: string | number;
  labels: Record<string, string> | string;
};

function parseLabels(raw: MetricRow["labels"]): Record<string, string> {
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = String(value);
    }
    return out;
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseLabels(parsed as Record<string, string>);
      }
    } catch {
      return {};
    }
  }
  return {};
}

function parseSource(raw: string | undefined): ProbeSource {
  return raw === "pull" ? "pull" : "attach";
}

function finiteNum(value: string | number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: MetricRow): ProbeSample | null {
  const value = finiteNum(row.value);
  if (value === null) {
    return null;
  }
  const labels = parseLabels(row.labels);
  const service = labels.service?.trim() ?? "";
  if (!service) {
    return null;
  }
  const up: ProbeUp = metricValueToUp(value);
  return {
    ts: toIsoTimestamp(row.ts),
    service,
    host: labels.host ?? "",
    check: labels.check ?? "",
    target: labels.target ?? "",
    up,
    source: parseSource(labels.source),
  };
}

function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  range: string | undefined,
): { from: string; to: string } {
  if (range) {
    const window = resolveRange(range);
    if (!window) {
      throw new InvalidRangeError(range);
    }
    const clamped = clampSearchSpan(window.from, window.to);
    return { from: clamped.from ?? window.from, to: clamped.to ?? window.to };
  }
  if (!from || !to) {
    throw new InvalidRangeError("from/to or range");
  }
  const clamped = clampSearchSpan(from, to);
  return { from: clamped.from ?? from, to: clamped.to ?? to };
}

export async function searchProbes(filters: {
  from?: string;
  to?: string;
  range?: string;
  service?: string;
}): Promise<{ probes: ProbeSample[] }> {
  const window = resolveWindow(filters.from, filters.to, filters.range);
  const params: Record<string, string> = {
    from: window.from,
    to: window.to,
    metric_name: probeMetricName,
  };
  const extra: string[] = [];
  if (filters.service) {
    extra.push("AND labels[{service_key:String}] = {service:String}");
    params.service_key = "service";
    params.service = filters.service;
  }
  const rows = await clickhouseQuery<MetricRow>(
    `
    SELECT ts, value, labels
    FROM metrics
    WHERE tenant_id = 'default'
      AND name = {metric_name:String}
      AND ts >= parseDateTime64BestEffort({from:String})
      AND ts <= parseDateTime64BestEffort({to:String})
      ${extra.join(" ")}
    ORDER BY ts
    LIMIT ${maxProbes}
    `,
    params,
  );
  const probes: ProbeSample[] = [];
  for (const row of rows) {
    const sample = mapRow(row);
    if (sample) {
      probes.push(sample);
    }
  }
  return { probes };
}

export async function probesRoute(c: Context): Promise<Response> {
  const from = c.req.query("from") ?? undefined;
  const to = c.req.query("to") ?? undefined;
  const range = c.req.query("range") ?? undefined;
  if (!range && (!from || !to)) {
    return c.json({ error: "from/to or range is required" }, 400);
  }
  const service = c.req.query("service")?.trim() || undefined;
  try {
    return c.json(await searchProbes({ from, to, range, service }));
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}
