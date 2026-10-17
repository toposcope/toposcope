import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { getDb } from "./index";
import { getSaved, type SavedSearch } from "./saved-searches";

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

/** `PUT /api/home` `{ saved_id }` marks a saved search Home; `null` unmarks it. */
export async function putHome(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).saved_id : undefined;
  if (raw === null) {
    writeHomeSavedId(null);
    return c.json({ saved_id: null });
  }
  if (typeof raw !== "string" || !raw) {
    return c.json({ error: "saved_id is required" }, 400);
  }
  const saved = getSaved(raw);
  if (!saved) {
    return c.json({ error: "Saved search not found" }, 404);
  }
  if (saved.board) {
    return c.json({ error: boardHomeRefuse }, 400);
  }
  writeHomeSavedId(saved.id);
  return c.json({ saved_id: saved.id });
}
