import { actorName, stampCreated, stampUpdated, type ActorName } from "./actors";
import { actorOf } from "../actor-context";
import { roleAtLeast, type Actor } from "./people";
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
import { metricRefUnit } from "../query/metric-series";
import {
  boardWatchRefuse,
  formatBoard,
  parseBoard,
  type BoardSlots,
} from "../shared/boards";
import { formatPromotedCols, parsePromotedCols } from "../shared/attrs";
import { closeByEdit } from "../alerts/monitor-store";
import { cantTellNow } from "../alerts/cant-tell";
import { lastLineAt } from "../alerts/last-line";
import { searchWindowMs } from "../alerts/monitor";
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
  /** Home's Pinned column (#259): pinned by the person asking (#306). */
  pinned: boolean;
  created_at: number;
  /** Who saved it (#306); null for a hunt saved before 0.9 that no Owner has taken yet. */
  owner_id: string | null;
  /** On everyone's Home, or only its owner's (#306). */
  shared: boolean;
  /** Who saved it, by name (#307): "saved by Maya K." */
  saved_by?: ActorName | null;
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
  pinned: number;
  created_at: number;
  owner_id: string | null;
  shared: number;
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
  pinned: boolean;
};

const savedSelect =
  "SELECT id, name, query, from_ts, to_ts, range, agg, widgets, board, cols, pinned, created_at, owner_id, shared FROM saved_searches";

function fromRow(row: SavedRow): SavedSearch {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    shared: row.shared !== 0,
    widgets: parseSavedLayout(row.widgets),
    board: parseBoard(row.board),
    cols: parsePromotedCols(row.cols),
  };
}

export function allSaved(): SavedSearch[] {
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

export function parseSavedFields(
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
  const pinned = typeof rec.pinned === "boolean" ? rec.pinned : (fallback?.pinned ?? false);
  return { name, query, range, from_ts, to_ts, agg: agg ?? null, widgets, board, cols, pinned };
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

/**
 * A panel draws one unit on one axis (#169): merging a metric whose unit is
 * known and differs from the panel's own is refused, naming the line and both
 * units. A metric not sent yet has no unit to compare and is let through.
 */
export async function mixedUnits(layout: WidgetLayout | null): Promise<string | null> {
  try {
    for (const [i, widget] of (layout?.widgets ?? []).entries()) {
      if (!widget.metric || !widget.lines?.length) {
        continue;
      }
      const own = await metricRefUnit(widget.metric);
      for (const [j, line] of widget.lines.entries()) {
        const unit = await metricRefUnit(line.metric);
        if (own && unit && unit !== own) {
          return `widgets[${i}].lines[${j}]: ${line.metric} is ${unit}, the panel is ${own}`;
        }
      }
    }
  } catch {
    // The store did not answer: the panel is saved, and its lines are checked again as they draw (17e).
  }
  return null;
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

/** Who may see a hunt: everyone when it is shared, else only the person who saved it. */
export function canSee(saved: SavedSearch, actor: Actor | null): boolean {
  return saved.shared || (actor !== null && saved.owner_id === actor.person.id);
}

function pinsOf(personId: string): Set<string> {
  const rows = getDb().query("SELECT saved_id FROM person_pins WHERE person_id = ?").all(personId) as Array<{ saved_id: string }>;
  return new Set(rows.map((r) => r.saved_id));
}

/** The hunts this person sees, each with their own pin (#306). */
export function visibleSaved(actor: Actor | null): SavedSearch[] {
  const pins = actor ? pinsOf(actor.person.id) : new Set<string>();
  return allSaved()
    .filter((s) => canSee(s, actor))
    .map((s) => ({ ...s, pinned: pins.has(s.id), saved_by: actorName(s.owner_id) }));
}

function withPin(saved: SavedSearch, actor: Actor | null): SavedSearch {
  return { ...saved, pinned: actor ? pinsOf(actor.person.id).has(saved.id) : false, saved_by: actorName(saved.owner_id) };
}

/** Whether this person has pinned this saved search. */
export function pinnedFor(personId: string, savedId: string): boolean {
  return pinsOf(personId).has(savedId);
}

function setPin(personId: string, savedId: string, pinned: boolean): void {
  if (pinned) {
    getDb().query("INSERT OR IGNORE INTO person_pins (person_id, saved_id) VALUES (?, ?)").run(personId, savedId);
  } else {
    getDb().query("DELETE FROM person_pins WHERE person_id = ? AND saved_id = ?").run(personId, savedId);
  }
}

/** A Viewer saves only their own hunts; an Operator may share one (30d, 30e). */
function sharedFor(rec: Record<string, unknown>, actor: Actor | null, fallback: boolean): boolean | { error: string } {
  if (rec.shared === undefined) {
    return fallback;
  }
  if (typeof rec.shared !== "boolean") {
    return { error: "shared is true or false" };
  }
  if (rec.shared && actor && !roleAtLeast(actor.role, "operator")) {
    return { error: "A Viewer may not share a hunt: ask an Operator" };
  }
  return rec.shared;
}

export async function listSavedSearches(c: Context): Promise<Response> {
  return c.json({ searches: visibleSaved(actorOf(c)) });
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
  const mixed = await mixedUnits(fields.widgets);
  if (mixed) {
    return c.json({ error: mixed }, 400);
  }
  const actor = actorOf(c);
  const shared = sharedFor(rec, actor, actor ? roleAtLeast(actor.role, "operator") : true);
  if (typeof shared === "object") {
    return c.json({ error: shared.error }, 403);
  }
  const search: SavedSearch = {
    id: crypto.randomUUID(),
    ...fields,
    created_at: Date.now(),
    owner_id: actor?.person.id ?? null,
    shared,
  };
  getDb()
    .query(
      "INSERT INTO saved_searches (id, name, query, from_ts, to_ts, range, agg, widgets, board, cols, pinned, created_at, owner_id, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      0,
      search.created_at,
      search.owner_id,
      search.shared ? 1 : 0,
    );
  if (actor && search.pinned) {
    setPin(actor.person.id, search.id, true);
  }
  stampCreated("saved_searches", search.id);
  return c.json(search, 201);
}

export async function updateSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const actor = actorOf(c);
  const found = getSaved(id);
  if (!found || !canSee(found, actor)) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  const existing = withPin(found, actor);
  const rec = await readJsonObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const mine = actor === null || existing.owner_id === actor.person.id;
  const onlyPin = Object.keys(rec).every((k) => k === "pinned");
  // Pinning is each person's own; changing a hunt someone else saved takes an Operator.
  if (!mine && !onlyPin && actor && !roleAtLeast(actor.role, "operator")) {
    return c.json({ error: "A Viewer may change only their own hunts: ask an Operator", need: "operator" }, 403);
  }
  const shared = sharedFor(rec, actor, existing.shared);
  if (typeof shared === "object") {
    return c.json({ error: shared.error }, 403);
  }
  if (actor && typeof rec.pinned === "boolean") {
    setPin(actor.person.id, id, rec.pinned);
  }
  const fields = parseSavedFields(rec, existing);
  if ("error" in fields) {
    return c.json({ error: fields.error }, 400);
  }
  const mixed = await mixedUnits(fields.widgets);
  if (mixed) {
    return c.json({ error: mixed }, 400);
  }
  getDb()
    .query(
      "UPDATE saved_searches SET name = ?, query = ?, from_ts = ?, to_ts = ?, range = ?, agg = ?, widgets = ?, board = ?, cols = ?, shared = ? WHERE id = ?",
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
      shared ? 1 : 0,
      id,
    );
  getDb()
    .query("UPDATE alert_rules SET query = ? WHERE saved_search_id = ?")
    .run(fields.query, id);
  // A monitor open on this search now reads something else: it closes without a call (#175).
  if (
    fields.query !== existing.query ||
    fields.range !== existing.range ||
    fields.from_ts !== existing.from_ts ||
    fields.to_ts !== existing.to_ts ||
    fields.agg !== existing.agg
  ) {
    const open = getDb()
      .query("SELECT id FROM alert_rules WHERE saved_search_id = ? AND state = 'open'")
      .all(id) as Array<{ id: string }>;
    for (const row of open) {
      closeByEdit(row.id, Date.now());
    }
  }
  if (!onlyPin) {
    stampUpdated("saved_searches", id);
  }
  const updated = getSaved(id);
  return c.json(updated ? withPin(updated, actor) : null);
}

export async function deleteSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const actor = actorOf(c);
  const existing = getSaved(id);
  if (!existing || !canSee(existing, actor)) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  // A shared hunt is deleted by whoever saved it, or an Owner.
  if (actor && existing.owner_id !== actor.person.id && !roleAtLeast(actor.role, "owner")) {
    return c.json({ error: "Only whoever saved this hunt, or an Owner, may delete it", need: "owner" }, 403);
  }
  const refs = getDb()
    .query("SELECT count(*) AS n FROM alert_rules WHERE saved_search_id = ?")
    .get(id) as { n: number };
  if (refs.n > 0) {
    return c.json({ error: "Saved search is used by an alert rule" }, 409);
  }
  getDb().query("DELETE FROM saved_searches WHERE id = ?").run(id);
  getDb().query("DELETE FROM person_pins WHERE saved_id = ?").run(id);
  getDb().query("DELETE FROM settings WHERE key = 'home_saved_id' AND value = ?").run(id);
  return c.json({ ok: true });
}

export async function runSavedSearch(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "id required" }, 400);
  }
  const saved = getSaved(id);
  if (!saved || !canSee(saved, actorOf(c))) {
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
  if (!saved || !canSee(saved, actorOf(c))) {
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
    const [series, lastLine] = await Promise.all([
      evaluateAlertSeries(saved),
      // For fewer than (#176): when it last matched a line, and whether a reading now could tell.
      lastLineAt(saved.query),
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
      ...(lastLine !== undefined ? { last_line_at: lastLine } : {}),
      cant_tell: saved.range ? cantTellNow(saved.query, searchWindowMs(saved)) : null,
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
