import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import {
  maxChangeMarks,
  parseChangeMarkKind,
  type ChangeMark,
  type ChangeMarkKind,
} from "../shared/change-mark";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";

type MarkRow = {
  ts: string;
  kind: string;
  service: string;
  title: string;
  attrs: Record<string, string> | string;
};

function parseAttrs(raw: MarkRow["attrs"]): Record<string, string> {
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
      if (parsed && typeof parsed === "object") {
        return parseAttrs(parsed as Record<string, string>);
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapRow(row: MarkRow): ChangeMark {
  const kind = parseChangeMarkKind(row.kind) ?? "note";
  return {
    ts: toIsoTimestamp(row.ts),
    kind,
    service: row.service,
    title: row.title,
    attrs: parseAttrs(row.attrs),
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

export async function searchChangeMarks(filters: {
  from?: string;
  to?: string;
  range?: string;
  kind?: ChangeMarkKind;
  service?: string;
}): Promise<{ marks: ChangeMark[] }> {
  const window = resolveWindow(filters.from, filters.to, filters.range);
  const params: Record<string, string> = {
    from: window.from,
    to: window.to,
  };
  const where = [
    "tenant_id = 'default'",
    "ts >= parseDateTime64BestEffort({from:String})",
    "ts <= parseDateTime64BestEffort({to:String})",
  ];
  if (filters.kind) {
    where.push("kind = {kind:String}");
    params.kind = filters.kind;
  }
  if (filters.service) {
    where.push("service = {service:String}");
    params.service = filters.service;
  }
  const rows = await clickhouseQuery<MarkRow>(
    `
    SELECT ts, kind, service, title, attrs
    FROM change_marks
    WHERE ${where.join(" AND ")}
    ORDER BY ts
    LIMIT ${maxChangeMarks}
    `,
    params,
  );
  return { marks: rows.map(mapRow) };
}

export async function marksRoute(c: Context): Promise<Response> {
  const kindRaw = c.req.query("kind") ?? undefined;
  const kind = kindRaw ? parseChangeMarkKind(kindRaw) : null;
  if (kindRaw && !kind) {
    return c.json({ error: "kind must be deploy, flag, incident, or note" }, 400);
  }
  const from = c.req.query("from") ?? undefined;
  const to = c.req.query("to") ?? undefined;
  const range = c.req.query("range") ?? undefined;
  if (!range && (!from || !to)) {
    return c.json({ error: "from/to or range is required" }, 400);
  }
  const service = c.req.query("service")?.trim() || undefined;
  try {
    return c.json(
      await searchChangeMarks({
        from,
        to,
        range,
        kind: kind ?? undefined,
        service,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}
