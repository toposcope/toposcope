import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { getDb } from "./index";
import { actorOf } from "../actor-context";
import { canSee, getSaved, type SavedSearch } from "./saved-searches";

/** "A board opens with its inputs unset", so it would land on nothing (12h). */
export const boardHomeRefuse = "A board cannot be Home: it opens with its inputs unset.";

/** The saved search the bare address opens on (#109), the instance's own: one password, one home. */
export function homeSavedId(db: Database = getDb()): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = 'home_saved_id'").get() as
    | { value: string }
    | undefined;
  return row?.value || null;
}

/** Home, when it is still a plain saved search. */
export function homeSaved(): SavedSearch | null {
  const id = homeSavedId();
  if (!id) {
    return null;
  }
  const saved = getSaved(id);
  return saved && !saved.board ? saved : null;
}

export function writeHomeSavedId(id: string | null, db: Database = getDb()): void {
  if (id === null) {
    db.query("DELETE FROM settings WHERE key = 'home_saved_id'").run();
    return;
  }
  db.query(
    "INSERT INTO settings (key, value) VALUES ('home_saved_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(id);
}

/** A deleted search is no longer Home. */
export function forgetHomeIf(savedId: string, db: Database = getDb()): void {
  if (homeSavedId(db) === savedId) {
    writeHomeSavedId(null, db);
  }
}

export async function getHome(c: Context): Promise<Response> {
  return c.json({ saved_id: homeSaved()?.id ?? null });
}

/** Home is everyone's (#361): an agent marks it only where none is, and unmarks only its own mark. */
export const agentHomeMarked = "Home is marked already, and Home is everyone's: an agent marks Home only where none is marked. Ask a person to change it in the app";
export const agentHomeUnmark = "Home is everyone's: an agent unmarks it only with the undo of its own mark (home_set with if_home)";
export const homeMoved = "Home is no longer the saved search this call expects (if_home), so it was left as it is";
export const homeNotShared = "Home is everyone's: only a shared saved search can be Home. Share it first";

/**
 * `PUT /api/home` `{ saved_id, if_home? }` marks a saved search Home; `null` unmarks it. With
 * `if_home` (a saved search's id, or null for none), it changes Home only while Home is still that,
 * which is how an undo leaves alone a Home someone changed since.
 */
export async function putHome(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = rec.saved_id;
  const actor = actorOf(c);
  const agent = actor !== null && actor.via === "token" && actor.person.agent === 1;
  const current = homeSavedId();
  if (rec.if_home !== undefined) {
    if (rec.if_home !== null && typeof rec.if_home !== "string") {
      return c.json({ error: "if_home is a saved search's id, or null", field: "if_home" }, 400);
    }
    if (rec.if_home !== current) {
      return c.json({ error: homeMoved, saved_id: current }, 409);
    }
  }
  if (raw === null) {
    if (agent && rec.if_home === undefined && current !== null) {
      return c.json({ error: agentHomeUnmark }, 409);
    }
    writeHomeSavedId(null);
    return c.json({ saved_id: null });
  }
  if (typeof raw !== "string" || !raw) {
    return c.json({ error: "saved_id is required" }, 400);
  }
  const saved = getSaved(raw);
  if (!saved || !canSee(saved, actor)) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardHomeRefuse }, 400);
  }
  if (!saved.shared) {
    return c.json({ error: homeNotShared }, 400);
  }
  if (agent && current !== null && current !== saved.id && rec.if_home === undefined) {
    return c.json({ error: agentHomeMarked, saved_id: current }, 409);
  }
  writeHomeSavedId(saved.id);
  return c.json({ saved_id: saved.id });
}
