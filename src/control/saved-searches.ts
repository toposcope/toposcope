import type { Context } from "hono";
import { evaluateAlertSeries, seriesFromSearch, applyHistogramCountRefuse } from "../alerts/series";
import { QueryCompileError } from "../query/compile";
import { search, searchLogs } from "../query";
import { formatSearchAgg, InvalidAggError, LogsScanBudgetError, parseSearchAgg } from "../query/agg";
import { InvalidRangeError, isRelativeRange, parseRangeMs } from "../query/relative";
import {
  defaultLayout,
  formatSavedLayout,
  parseSavedLayout,
  type WidgetLayout,
} from "../shared/widgets";
import {
  boardWatchRefuse,
  formatBoard,
  parseBoard,
  type BoardSlots,
} from "../shared/boards";
import { formatPromotedCols, parsePromotedCols } from "../shared/attrs";
import { getDb } from "./index";

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  from_ts: string | null;
  to_ts: string | null;
  range: string | null;
  agg: string | null;
  widgets: WidgetLayout | null;
  board: BoardSlots | null;
  cols: string[];
  created_at: number;
};

type SavedRow = {
  id: string;
  name: string;
  query: string;
  from_ts: string | null;
  to_ts: string | null;
  range: string | null;
  agg: string | null;
  widgets: string | null;
  board: string | null;
  cols: string | null;
  created_at: number;
};

type SavedFields = {
  name: string;
  query: string;
  range: string | null;
  from_ts: string | null;
  to_ts: string | null;
  agg: string | null;
  widgets: WidgetLayout | null;
  board: BoardSlots | null;
  cols: string[];
};

const savedSelect =
  "SELECT id, name, query, from_ts, to_ts, range, agg, widgets, board, cols, created_at FROM saved_searches";

function fromRow(row: SavedRow): SavedSearch {
  return {
    ...row,
    widgets: parseSavedLayout(row.widgets),
    board: parseBoard(row.board),
    cols: parsePromotedCols(row.cols),
  };
}

function allSaved(): SavedSearch[] {
  return (
    getDb()
      .query(`${savedSelect} ORDER BY created_at DESC`)
      .all() as SavedRow[]
  ).map(fromRow);
}

function parseSavedAgg(
  rec: Record<string, unknown>,
  fallback?: SavedSearch,
): string | null | { error: string } {
  if (!("agg" in rec)) {
    return fallback?.agg ?? null;
  }
  if (rec.agg === null) {
    return null;
  }
  if (typeof rec.agg !== "string") {
    return { error: "Invalid agg" };
  }
  try {
    const parsed = parseSearchAgg(rec.agg);
    return parsed ? formatSearchAgg(parsed) : null;
  } catch (err) {
    if (err instanceof InvalidAggError) {
      return { error: err.message };
    }
    throw err;
  }
}

function parseSavedFields(
  rec: Record<string, unknown>,
  fallback?: SavedSearch,
): SavedFields | { error: string } {
  const nameRaw = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameRaw.length > 0 ? nameRaw : (fallback?.name ?? "");
  if (name.length === 0) {
    return { error: "name is required" };
  }
  const query = typeof rec.query === "string" ? rec.query : (fallback?.query ?? "");
  const rangeRaw = typeof rec.range === "string" ? rec.range.trim() : "";
  const range =
    rangeRaw.length > 0 ? rangeRaw : rec.range === null ? null : (fallback?.range ?? null);
  if (range && parseRangeMs(range) === null) {
    return { error: "Invalid range" };
  }
  const from_ts = range
    ? null
    : typeof rec.from_ts === "string"
      ? rec.from_ts
      : rec.from_ts === null
        ? null
        : (fallback?.from_ts ?? null);
  const to_ts = range
    ? null
    : typeof rec.to_ts === "string"
      ? rec.to_ts
      : rec.to_ts === null
        ? null
        : (fallback?.to_ts ?? null);
  const agg = parseSavedAgg(rec, fallback);
  if (agg && typeof agg === "object" && "error" in agg) {
    return agg;
  }
  const widgets = parseSavedWidgets(rec, fallback);
  const board = parseSavedBoard(rec, fallback);
  if (board && typeof board === "object" && "error" in board) {
    return board;
  }
  if (board?.win && (!range || !isRelativeRange(range))) {
    return { error: "A board window is a relative range — Quick or Last N only." };
  }
  const cols = parseSavedCols(rec, fallback);
  if (!Array.isArray(cols)) {
    return cols;
  }
  return { name, query, range, from_ts, to_ts, agg: agg ?? null, widgets, board, cols };
}

function parseSavedBoard(
  rec: Record<string, unknown>,
  fallback?: SavedSearch,
): BoardSlots | null | { error: string } {
  if (!("board" in rec)) {
    return fallback?.board ?? null;
  }
  if (rec.board === null) {
    return null;
  }
  const parsed = parseBoard(rec.board);
  if (rec.board && !parsed) {
    return { error: "Invalid board" };
  }
  return parsed;
}

function parseSavedWidgets(
  rec: Record<string, unknown>,
  fallback?: SavedSearch,
): WidgetLayout | null {
  if (!("widgets" in rec)) {
    return fallback?.widgets ?? null;
  }
  if (rec.widgets === null) {
    return null;
  }
  return parseSavedLayout(rec.widgets);
}

function parseSavedCols(
  rec: Record<string, unknown>,
  fallback?: SavedSearch,
): string[] | { error: string } {
  if (!("cols" in rec)) {
    return fallback?.cols ?? [];
  }
  if (rec.cols === null) {
    return [];
  }
  if (typeof rec.cols !== "string" && !Array.isArray(rec.cols)) {
    return { error: "Invalid cols" };
  }
  return parsePromotedCols(rec.cols);
}

async function readJsonObject(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  return body as Record<string, unknown>;
}

export function getSaved(id: string): SavedSearch | null {
  const row = getDb()
    .query(`${savedSelect} WHERE id = ?`)
    .get(id) as SavedRow | undefined;
  return row ? fromRow(row) : null;
}

export async function listSavedSearches(c: Context): Promise<Response> {
  return c.json({ searches: allSaved() });
}

export async function createSavedSearch(c: Context): Promise<Response> {
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const fields = parseSavedFields(rec);
  if ("error" in fields) {
    return c.json({ error: fields.error }, 400);
  }
  const search: SavedSearch = {
    id: crypto.randomUUID(),
    ...fields,
    created_at: Date.now(),
  };
  getDb()
    .query(
      "INSERT INTO saved_searches (id, name, query, from_ts, to_ts, range, agg, widgets, board, cols, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      search.id,
      search.name,
      search.query,
      search.from_ts,
      search.to_ts,
      search.range,
      search.agg,
      formatSavedLayout(search.widgets ?? defaultLayout()),
      formatBoard(search.board),
      formatPromotedCols(search.cols),
      search.created_at,
    );
  return c.json(search, 201);
}

export async function updateSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const existing = getSaved(id);
  if (!existing) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const fields = parseSavedFields(rec, existing);
  if ("error" in fields) {
    return c.json({ error: fields.error }, 400);
  }
  getDb()
    .query(
      "UPDATE saved_searches SET name = ?, query = ?, from_ts = ?, to_ts = ?, range = ?, agg = ?, widgets = ?, board = ?, cols = ? WHERE id = ?",
    )
    .run(
      fields.name,
      fields.query,
      fields.from_ts,
      fields.to_ts,
      fields.range,
      fields.agg,
      formatSavedLayout(fields.widgets ?? defaultLayout()),
      formatBoard(fields.board),
      formatPromotedCols(fields.cols),
      id,
    );
  getDb()
    .query("UPDATE alert_rules SET query = ? WHERE saved_search_id = ?")
    .run(fields.query, id);
  const updated = getSaved(id);
  return c.json(updated);
}

export async function deleteSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const existing = getSaved(id);
  if (!existing) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  const refs = getDb()
    .query("SELECT count(*) AS n FROM alert_rules WHERE saved_search_id = ?")
    .get(id) as { n: number };
  if (refs.n > 0) {
    return c.json({ error: "Saved search is used by an alert rule" }, 409);
  }
  getDb().query("DELETE FROM saved_searches WHERE id = ?").run(id);
  return c.json({ ok: true });
}

export async function runSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const saved = getSaved(id);
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardWatchRefuse(saved) }, 400);
  }
  const filters = {
    q: saved.query,
    range: saved.range ?? undefined,
    from: saved.from_ts ?? undefined,
    to: saved.to_ts ?? undefined,
  };
  try {
    const result = await search({
      ...filters,
      events: "0",
      ...(saved.agg ? { agg: saved.agg } : {}),
    });
    const series = applyHistogramCountRefuse(
      seriesFromSearch(saved.agg, result.total, result.agg),
      result.scan,
    );
    return c.json({
      ...result,
      count: series.count,
      value: series.value,
      refused: series.refused,
      reason: series.reason,
    });
  } catch (err) {
    if (
      err instanceof InvalidRangeError ||
      err instanceof QueryCompileError ||
      err instanceof InvalidAggError
    ) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}

export async function testSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const saved = getSaved(id);
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardWatchRefuse(saved) }, 400);
  }
  const filters = {
    q: saved.query,
    range: saved.range ?? undefined,
    from: saved.from_ts ?? undefined,
    to: saved.to_ts ?? undefined,
    limit: 10,
  };
  try {
    let sample: Awaited<ReturnType<typeof searchLogs>> = [];
    const [series] = await Promise.all([
      evaluateAlertSeries(saved),
      searchLogs(filters)
        .then((events) => {
          sample = events;
        })
        .catch((err) => {
          if (!(err instanceof LogsScanBudgetError)) {
            throw err;
          }
        }),
    ]);
    return c.json({
      count: series.count,
      value: series.value,
      agg: series.expr,
      refused: series.refused,
      reason: series.reason,
      sample,
    });
  } catch (err) {
    if (
      err instanceof InvalidRangeError ||
      err instanceof QueryCompileError ||
      err instanceof InvalidAggError
    ) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}
