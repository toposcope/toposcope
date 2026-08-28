import type { Context } from "hono";
import { clickhouseQuery, toIsoTimestamp } from "../shared/clickhouse";
import {
  fallbackChangeMarkId,
  keepLatestChangeMarkPerId,
  maxChangeMarks,
  parseChangeMarkKind,
  type ChangeMark,
  type ChangeMarkKind,
} from "../shared/change-mark";
import { clampSearchSpan, InvalidRangeError, resolveRange } from "./relative";

type MarkRow = {
  ts: string;
  end_ts: string | null;
  kind: string;
  service: string;
  title: string;
  attrs: Record<string, string> | string;
  id: string;
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

function parseEndTs(raw: MarkRow["end_ts"]): string | null {
  if (raw == null || raw === "") {
    return null;
  }
  try {
    return toIsoTimestamp(raw);
  } catch {
    return null;
  }
}

function mapRow(row: MarkRow): ChangeMark {
  const kind = parseChangeMarkKind(row.kind) ?? "note";
  const ts = toIsoTimestamp(row.ts);
  const title = row.title;
  const service = row.service;
  const id = row.id?.trim()
    ? row.id.trim()
    : fallbackChangeMarkId({ ts, kind, service, title });
  return {
    id,
    ts,
    end_ts: parseEndTs(row.end_ts),
    kind,
    service,
    title,
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

const markSelect = `ts, end_ts, kind, service, title, attrs, id`;

function extraWhere(
  filters: { kind?: ChangeMarkKind; service?: string },
  params: Record<string, string>,
): string {
  const extra: string[] = [];
  if (filters.kind) {
    extra.push("AND kind = {kind:String}");
    params.kind = filters.kind;
  }
  if (filters.service) {
    extra.push("AND service = {service:String}");
    params.service = filters.service;
  }
  return extra.join(" ");
}

export async function lookupChangeMarkIds(
  ids: string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return new Set();
  }
  const params: Record<string, string> = {};
  const ors = unique.map((id, i) => {
    params[`mid${i}`] = id;
    return `id = {mid${i}:String}`;
  });
  const rows = await clickhouseQuery<{ id: string }>(
    `SELECT DISTINCT id FROM change_marks WHERE tenant_id = 'default' AND (${ors.join(" OR ")})`,
    params,
  );
  return new Set(rows.map((row) => row.id));
}

export async function getChangeMarkById(id: string): Promise<ChangeMark | null> {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }
  const rows = await clickhouseQuery<MarkRow>(
    `
    SELECT ${markSelect}
    FROM change_marks
    WHERE tenant_id = 'default' AND id = {id:String}
    LIMIT 1
    `,
    { id: trimmed },
  );
  if (rows[0]) {
    return mapRow(rows[0]);
  }
  const unlabeled = await clickhouseQuery<MarkRow>(
    `
    SELECT ${markSelect}
    FROM change_marks
    WHERE tenant_id = 'default' AND id = ''
    ORDER BY ts DESC
    LIMIT ${maxChangeMarks}
    `,
  );
  return unlabeled.map(mapRow).find((mark) => mark.id === trimmed) ?? null;
}

export async function searchChangeMarks(filters: {
  from?: string;
  to?: string;
  range?: string;
  kind?: ChangeMarkKind;
  service?: string;
}): Promise<{
  marks: ChangeMark[];
  before: ChangeMark | null;
  after: ChangeMark | null;
}> {
  const window = resolveWindow(filters.from, filters.to, filters.range);
  const params: Record<string, string> = {
    from: window.from,
    to: window.to,
  };
  const extra = extraWhere(filters, params);
  const [rows, beforeRows, afterRows] = await Promise.all([
    clickhouseQuery<MarkRow>(
      `
      SELECT ${markSelect}
      FROM change_marks
      WHERE tenant_id = 'default'
        AND ts >= parseDateTime64BestEffort({from:String})
        AND ts <= parseDateTime64BestEffort({to:String})
        ${extra}
      ORDER BY ts
      LIMIT ${maxChangeMarks}
      `,
      params,
    ),
    clickhouseQuery<MarkRow>(
      `
      SELECT ${markSelect}
      FROM change_marks
      WHERE tenant_id = 'default'
        AND ts < parseDateTime64BestEffort({from:String})
        ${extra}
      ORDER BY ts DESC
      LIMIT 1
      `,
      params,
    ),
    clickhouseQuery<MarkRow>(
      `
      SELECT ${markSelect}
      FROM change_marks
      WHERE tenant_id = 'default'
        AND ts > parseDateTime64BestEffort({to:String})
        ${extra}
      ORDER BY ts
      LIMIT 1
      `,
      params,
    ),
  ]);
  return {
    marks: keepLatestChangeMarkPerId(rows.map(mapRow)),
    before: beforeRows[0] ? mapRow(beforeRows[0]) : null,
    after: afterRows[0] ? mapRow(afterRows[0]) : null,
  };
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
