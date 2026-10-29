import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { stampUpdated } from "../control/actors";
import { homeSavedId } from "../control/home";
import { getDb } from "../control/index";
import { roleAtLeast } from "../control/people";
import { canSee, getSaved, mixedUnits, type SavedSearch } from "../control/saved-searches";
import { attrFacets, facets, search } from "../query";
import { InvalidAggError } from "../query/agg";
import { QueryCompileError } from "../query/compile";
import { InvalidRangeError } from "../query/relative";
import { formatMetricLabels } from "../shared/metric";
import {
  defaultLayout,
  firstGap,
  formatSavedLayout,
  isPinnedHistogram,
  maxWidgets,
  moveWidget,
  nextWidgetId,
  parseSavedWidget,
  patchWidget,
  removeWidget,
  resizeWidget,
  widgetLineQueries,
  type WidgetDef,
  type WidgetLayout,
} from "../shared/widgets";
import { answerWith, readObject } from "./answer";
import { savedLink } from "./saved";

/**
 * Panels one at a time (#360). A saved search's canvas is up to six panels; the saved search
 * marked Home (`home` in place of its id) is the canvas its address opens on. `PUT
 * /api/saved-searches/:id` replaces the whole canvas, so an agent that adds one panel there can
 * drop someone's others by accident: these routes add, move or change, and remove one panel and
 * leave the rest where they are (a move nudges the panels it lands on down, as a drag does).
 */

type Canvas = { saved: SavedSearch; layout: WidgetLayout };

/** The saved search a panel route is about, and whether the caller may change it; a Response when not. */
function canvasOf(c: Context, change: boolean): Canvas | Response {
  const raw = c.req.param("id") ?? "";
  const id = raw === "home" ? homeSavedId() : raw;
  if (!id) {
    return c.json({ error: "No saved search is marked Home: home_set marks one, or give a saved search's id" }, 404);
  }
  const actor = actorOf(c);
  const saved = getSaved(id);
  if (!saved || !canSee(saved, actor)) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  const mine = actor === null || saved.owner_id === actor.person.id;
  if (change && !mine && actor && !roleAtLeast(actor.role, "operator")) {
    // The same sentence PUT /api/saved-searches/:id refuses with.
    return c.json({ error: "A Viewer may change only their own hunts: ask an Operator", need: "operator" }, 403);
  }
  return { saved, layout: saved.widgets ?? defaultLayout({ agg: saved.agg }) };
}

/** The fields of a panel a body may give; `id` is the canvas's to choose. */
const panelKeys = [
  "kind", "x", "y", "w", "h", "split", "chart", "agg", "replaceY", "logScale", "attr", "pct", "n",
  "metric", "metricLabels", "metricSplit", "metricChart", "topView", "lines", "names", "title", "note",
] as const;

function given(rec: Record<string, unknown>): Partial<Record<(typeof panelKeys)[number], unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of panelKeys) {
    if (rec[key] !== undefined) {
      out[key] = rec[key];
    }
  }
  return out;
}

function draftOf(rec: Record<string, unknown>, id: string, base?: WidgetDef): WidgetDef | null {
  return parseSavedWidget({ ...(base ?? { split: "level", chart: "stacked", agg: null, w: 6, h: 4 }), ...given(rec), id, x: rec.x ?? base?.x ?? 0, y: rec.y ?? base?.y ?? 0 });
}

async function write(c: Context, canvas: Canvas, widgets: WidgetDef[]): Promise<Response | null> {
  const layout: WidgetLayout = { logs: canvas.layout.logs, widgets };
  const mixed = await mixedUnits(layout);
  if (mixed) {
    return c.json({ error: mixed }, 400);
  }
  getDb().query("UPDATE saved_searches SET widgets = ? WHERE id = ?").run(formatSavedLayout(layout), canvas.saved.id);
  stampUpdated("saved_searches", canvas.saved.id);
  return null;
}

/** The answer of a panel write: the panel, every panel now, its link, and its undo. */
function answer(c: Context, canvas: Canvas, panelId: string, widgets: WidgetDef[], undo: { tool: string; arguments: Record<string, unknown>; does: string }, status: 200 | 201 = 200) {
  const saved = getSaved(canvas.saved.id)!;
  const res = c.json({ saved_id: saved.id, panel: widgets.find((w) => w.id === panelId) ?? null, panels: widgets }, status);
  return answerWith(res, () => ({ id: panelId, link: savedLink(saved), undo }));
}

/** The undo of a move, a change or a removal: the canvas put back as it was. */
function putBack(canvas: Canvas, what: string) {
  return {
    tool: "saved_search_update",
    arguments: { id: canvas.saved.id, body: { widgets: canvas.layout } },
    does: `Puts ${canvas.saved.name}'s panels back as they were before ${what}`,
  };
}

/** `POST /api/saved-searches/:id/panels`: one more panel, in the first gap or where it is asked for. */
export async function addPanelRoute(c: Context): Promise<Response> {
  const canvas = canvasOf(c, true);
  if (canvas instanceof Response) {
    return canvas;
  }
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const widgets = canvas.layout.widgets;
  const id = widgets.length < maxWidgets ? nextWidgetId(widgets) : null;
  if (!id) {
    return c.json({ error: `${canvas.saved.name} has ${maxWidgets} panels, the most a canvas holds: panel_remove one first` }, 400);
  }
  const draft = draftOf(rec, id);
  if (!draft) {
    return c.json({ error: "kind must be timeseries, stat or hbar", field: "kind" }, 400);
  }
  let next = [...widgets, firstGap(widgets, draft)];
  if (rec.x !== undefined || rec.y !== undefined) {
    next = moveWidget(next, id, draft.x, draft.y);
  }
  const refused = await write(c, canvas, next);
  if (refused) {
    return refused;
  }
  return answer(c, canvas, id, next, { tool: "panel_remove", arguments: { id: canvas.saved.id, panel: id }, does: `Removes panel ${id}, which this added, from ${canvas.saved.name}` }, 201);
}

/** `PUT /api/saved-searches/:id/panels/:panel`: move, resize or change one panel; what is left out stays. */
export async function putPanelRoute(c: Context): Promise<Response> {
  const canvas = canvasOf(c, true);
  if (canvas instanceof Response) {
    return canvas;
  }
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const panelId = c.req.param("panel") ?? "";
  const current = canvas.layout.widgets.find((w) => w.id === panelId);
  if (!current) {
    return c.json({ error: `${canvas.saved.name} has no panel ${panelId}: its panels are ${canvas.layout.widgets.map((w) => w.id).join(", ")}` }, 404);
  }
  const moves = rec.x !== undefined || rec.y !== undefined;
  if (moves && isPinnedHistogram(current)) {
    return c.json({ error: "Panel a is the pinned plot: it stays at the top left, and can be resized but not moved" }, 400);
  }
  const changed = draftOf(rec, panelId, current);
  if (!changed) {
    return c.json({ error: "kind must be timeseries, stat or hbar", field: "kind" }, 400);
  }
  const { x: _x, y: _y, w: _w, h: _h, ...fields } = changed;
  let next = patchWidget(canvas.layout.widgets, panelId, fields);
  if (rec.w !== undefined || rec.h !== undefined) {
    next = resizeWidget(next, panelId, changed.w, changed.h);
  }
  if (moves) {
    next = moveWidget(next, panelId, changed.x, changed.y);
  }
  const refused = await write(c, canvas, next);
  if (refused) {
    return refused;
  }
  return answer(c, canvas, panelId, next, putBack(canvas, `panel ${panelId} changed`));
}

/** `DELETE /api/saved-searches/:id/panels/:panel`: one panel off the canvas; the pinned plot stays. */
export async function removePanelRoute(c: Context): Promise<Response> {
  const canvas = canvasOf(c, true);
  if (canvas instanceof Response) {
    return canvas;
  }
  const panelId = c.req.param("panel") ?? "";
  const current = canvas.layout.widgets.find((w) => w.id === panelId);
  if (!current) {
    return c.json({ error: `${canvas.saved.name} has no panel ${panelId}` }, 404);
  }
  if (isPinnedHistogram(current)) {
    return c.json({ error: "Panel a is the pinned plot: every canvas keeps it" }, 400);
  }
  const next = removeWidget(canvas.layout.widgets, panelId);
  const refused = await write(c, canvas, next);
  if (refused) {
    return refused;
  }
  return answer(c, canvas, panelId, next, putBack(canvas, `panel ${panelId} was removed`));
}

/**
 * `POST /api/saved-searches/:id/panels/preview`: the series a panel would draw on that saved
 * search, over its window, before it is added. Nothing is stored.
 */
export async function previewPanelRoute(c: Context): Promise<Response> {
  const canvas = canvasOf(c, false);
  if (canvas instanceof Response) {
    return canvas;
  }
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const panel = draftOf(rec, nextWidgetId(canvas.layout.widgets) ?? "f");
  if (!panel) {
    return c.json({ error: "kind must be timeseries, stat or hbar", field: "kind" }, 400);
  }
  const { saved } = canvas;
  const window = saved.range ? { range: saved.range } : saved.from_ts || saved.to_ts ? { from: saved.from_ts ?? undefined, to: saved.to_ts ?? undefined } : { range: "1h" };
  const filters = { q: saved.query, ...window };
  try {
    if (panel.kind === "hbar") {
      const top = panel.attr
        ? ((await attrFacets(filters, [panel.attr], panel.n, false))[panel.attr] ?? [])
        : panel.split === "none"
          ? []
          : (await facets(filters, panel.n, false))[panel.split];
      return c.json({ saved_id: saved.id, panel, window, top });
    }
    const lines = await Promise.all(
      widgetLineQueries(panel).map(async (line) => {
        const res = await search({
          ...filters,
          events: "0",
          split: line.split,
          ...(line.agg ? { agg: line.agg } : {}),
          ...(line.metric ? { metric: line.metric, ml: formatMetricLabels(line.metricLabels) } : {}),
          ...(line.metricSplit ? { msplit: line.metricSplit } : {}),
        });
        const reads = line.metric ? `metric ${line.metric}` : line.agg ?? "count";
        if (res.agg) {
          return { reads, stat: res.agg.stat, refused: res.agg.source === "refused" ? (res.agg.reason ?? "refused") : null, bars: res.agg.buckets };
        }
        return {
          reads,
          stat: res.total,
          refused: res.scan?.histogram ? res.scan.reason : null,
          bars: res.histogram.map((b) => ({ t: b.t, v: b.n, ...(line.split !== "none" ? { by: b.series } : {}) })),
        };
      }),
    );
    return c.json({ saved_id: saved.id, panel, window, lines });
  } catch (err) {
    if (err instanceof InvalidRangeError || err instanceof QueryCompileError || err instanceof InvalidAggError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof Error && /metric/i.test(err.message)) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}
