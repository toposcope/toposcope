import type { Context, Handler } from "hono";
import { actorOf } from "../actor-context";
import { applyHistogramCountRefuse, seriesFromSearch } from "../alerts/series";
import { homeSavedId } from "../control/home";
import { getSaved, parseSavedFields, pinnedFor, type SavedSearch } from "../control/saved-searches";
import { search } from "../query";
import { InvalidAggError } from "../query/agg";
import { QueryCompileError } from "../query/compile";
import { InvalidRangeError } from "../query/relative";
import { savedSearchUrl } from "../ui/search-url";
import { answerWith, readObject } from "./answer";

/** A saved search's place in the app: the hunt it opens, with its window and its panels. */
export function savedLink(saved: SavedSearch): string {
  return `/${savedSearchUrl(saved)}`;
}

/** Everything `PUT /api/saved-searches/:id` takes to put this saved search back as it is. */
export function savedBodyOf(saved: SavedSearch, pinned: boolean | null): Record<string, unknown> {
  return {
    name: saved.name,
    query: saved.query,
    range: saved.range,
    from_ts: saved.from_ts,
    to_ts: saved.to_ts,
    agg: saved.agg,
    widgets: saved.widgets,
    board: saved.board,
    cols: saved.cols,
    shared: saved.shared,
    ...(pinned === null ? {} : { pinned }),
  };
}

/** `POST /api/saved-searches`, answering with its link and the delete that undoes it. */
export function savedCreateWithUndo(handler: Handler): Handler {
  return async (c, next) => {
    const res = await handler(c, next);
    if (!(res instanceof Response)) {
      return res;
    }
    return answerWith(res, async () => {
      const made = (await res.clone().json()) as SavedSearch;
      return {
        link: savedLink(made),
        undo: { tool: "saved_search_delete", arguments: { id: made.id }, does: `Deletes the saved search ${made.name}, which this made` },
      };
    });
  };
}

/** `PUT /api/saved-searches/:id`, answering with its link and the change that puts back what it was. */
export function savedUpdateWithUndo(handler: Handler): Handler {
  return async (c, next) => {
    const id = c.req.param("id") ?? "";
    const before = getSaved(id);
    const rec = await readObject(c);
    const actor = actorOf(c);
    const pinned = before && !(rec instanceof Response) && "pinned" in rec && actor ? pinnedFor(actor.person.id, id) : null;
    const res = await handler(c, next);
    if (!(res instanceof Response) || !before) {
      return res;
    }
    return answerWith(res, async () => {
      const after = (await res.clone().json()) as SavedSearch;
      return {
        link: savedLink(after),
        undo: { tool: "saved_search_update", arguments: { id, body: savedBodyOf(before, pinned) }, does: `Puts the saved search ${before.name} back as it was before this change` },
      };
    });
  };
}

/** A few rows, each in a line's worth: when, where, how loud, what it said. */
function sampleOf(events: Awaited<ReturnType<typeof search>>["events"]) {
  return events.slice(0, 5).map((e) => ({ ts: e.ts, service: e.service, host: e.host, level: e.level, message: e.message }));
}

/**
 * `POST /api/saved-searches/preview` (#360): what a saved search would find over its own window,
 * before it is saved. The body is a save's; nothing is stored.
 */
export async function savedPreviewRoute(c: Context): Promise<Response> {
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const fields = parseSavedFields({ name: "preview", ...rec });
  if ("error" in fields) {
    return c.json({ error: fields.error }, 400);
  }
  if (fields.board) {
    return c.json({ error: "A board opens with its inputs unset, so it finds nothing until they are: preview it with its inputs in the query" }, 400);
  }
  const range = fields.range ?? (fields.from_ts || fields.to_ts ? undefined : "1h");
  try {
    const result = await search({
      q: fields.query,
      ...(range ? { range } : { from: fields.from_ts ?? undefined, to: fields.to_ts ?? undefined }),
      limit: 5,
      ...(fields.agg ? { agg: fields.agg } : {}),
    });
    const series = applyHistogramCountRefuse(seriesFromSearch(fields.agg, result.total, result.agg), result.scan);
    return c.json({
      query: fields.query,
      agg: fields.agg,
      window: { range: range ?? null, from: result.from, to: result.to },
      rows: result.total,
      value: series.value,
      refused: series.refused,
      reason: series.reason ?? null,
      bars: result.histogram.map((b) => ({ t: b.t, n: b.n })),
      sample: sampleOf(result.events),
    });
  } catch (err) {
    if (err instanceof InvalidRangeError || err instanceof QueryCompileError || err instanceof InvalidAggError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}

/**
 * `PUT /api/home`, answering with Home's link and the call that puts Home back (#361): marking a
 * saved search Home is how an agent's panels reach Home on an instance where none is marked yet.
 */
export function homeSetWithUndo(handler: Handler): Handler {
  return async (c, next) => {
    const before = homeSavedId();
    const res = await handler(c, next);
    if (!(res instanceof Response)) {
      return res;
    }
    return answerWith(res, () => ({
      link: "/?view=home",
      undo: {
        tool: "home_set",
        arguments: { body: { saved_id: before } },
        does: before === null ? "Unmarks Home, as it was before" : "Marks Home the saved search that was Home before",
      },
    }));
  };
}
