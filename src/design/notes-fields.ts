import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { stampSetting } from "../control/actors";
import { readFieldConfig, writeFieldConfig } from "../control/fields";
import { roleAtLeast } from "../control/people";
import { insertChangeMarks } from "../ingest/marks";
import { getChangeMarkById } from "../query/marks";
import { InvalidChangeMarkError, parseChangeMarkRequest } from "../shared/change-mark";
import { clickhouseCommandWith } from "../shared/clickhouse";
import { fieldRoles, isRoleableKey, skipKeysFromRoles, type FieldRole } from "../shared/fields";
import { syncFieldRoleSkip } from "../shared/migrate";
import { answerWith, readObject } from "./answer";

/** Notes are on Home's clock, beside the deploys and flags. */
export const homeLink = "/?view=home";
export const fieldsLink = "/?view=fields";

/**
 * `POST /api/marks/notes` (#360): a note on the clock, as `+ note` on Home writes one, under the
 * caller's name. At now, or at `ts`.
 */
export async function writeNoteRoute(c: Context): Promise<Response> {
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  let parsed;
  try {
    parsed = parseChangeMarkRequest({ kind: "note", title: rec.title, ts: rec.ts, service: rec.service, attrs: rec.attrs });
  } catch (err) {
    if (err instanceof InvalidChangeMarkError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  const writer = actorOf(c);
  const mark = parsed.mark;
  if (writer) {
    mark.attrs = { ...mark.attrs, by: writer.person.name, by_id: writer.person.id };
  }
  await insertChangeMarks([mark]);
  const res = c.json({ ok: true, mark }, 201);
  return answerWith(res, () => ({
    id: mark.id,
    link: homeLink,
    undo: { tool: "note_delete", arguments: { id: mark.id }, does: `Takes the note "${mark.title}" off the clock` },
  }));
}

/**
 * `DELETE /api/marks/notes/:id`: one note off the clock, by whoever wrote it, or an Owner. Deploys,
 * flags and incidents are what senders said happened, and are not taken back here. A note copied
 * to a linked instance already stays there.
 */
export async function deleteNoteRoute(c: Context): Promise<Response> {
  const id = (c.req.param("id") ?? "").trim();
  const mark = id ? await getChangeMarkById(id) : null;
  if (!mark || mark.id !== id) {
    return c.json({ error: "Note not found" }, 404);
  }
  if (mark.kind !== "note") {
    return c.json({ error: `That mark is a ${mark.kind}: only a note is taken off the clock` }, 400);
  }
  const actor = actorOf(c);
  if (actor && mark.attrs.by_id !== actor.person.id && !roleAtLeast(actor.role, "owner")) {
    return c.json({ error: "Only whoever wrote this note, or an Owner, may take it off the clock", need: "owner" }, 403);
  }
  await clickhouseCommandWith("DELETE FROM change_marks WHERE tenant_id = 'default' AND kind = 'note' AND id = {id:String}", { id });
  return c.json({ ok: true, id });
}

/**
 * `PUT /api/fields/roles/:key` (#360): one field's role, the others as they are. `PUT /api/fields`
 * replaces every role and every link, so an agent setting one there would drop the rest.
 */
export async function putFieldRoleRoute(c: Context): Promise<Response> {
  const key = (c.req.param("key") ?? "").trim();
  if (!isRoleableKey(key)) {
    return c.json({ error: `${key} is not a field that takes a role`, field: "key" }, 400);
  }
  const rec = await readObject(c);
  if (rec instanceof Response) {
    return rec;
  }
  const role = rec.role;
  if (typeof role !== "string" || !(fieldRoles as readonly string[]).includes(role)) {
    return c.json({ error: `role must be ${fieldRoles.join(", ")}`, field: "role" }, 400);
  }
  const config = readFieldConfig();
  const previous: FieldRole = config.roles[key] ?? "chart";
  const roles = { ...config.roles };
  if (role === "chart") {
    delete roles[key];
  } else {
    roles[key] = role as FieldRole;
  }
  const stored = writeFieldConfig(roles, config.links);
  stampSetting("fields");
  await syncFieldRoleSkip(skipKeysFromRoles(roles));
  const res = c.json({ key, role, was: previous, roles: stored.roles });
  return answerWith(res, () => ({
    id: key,
    link: fieldsLink,
    undo: { tool: "field_role_set", arguments: { key, body: { role: previous } }, does: `Gives ${key} back its role ${previous}` },
  }));
}
