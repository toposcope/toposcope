import * as v from "valibot";
import { optionalText } from "./common";

function described<T extends v.GenericSchema>(schema: T, description: string) {
  return v.pipe(schema, v.description(description));
}

export const homeSinceQuery = v.object({
  mark: optionalText("A change mark's id: what changed since it."),
  since: optionalText("hour: what changed in the last hour."),
});

export const homeBody = v.object({
  saved_id: v.nullable(described(v.string("saved_id is required"), "The saved search to mark Home, a shared one; null unmarks it. Home is everyone's: an agent marks it only where none is."), ),
  if_home: v.optional(v.nullable(described(v.string(), "Change Home only while it is this saved search (null: while none is); otherwise 409 and Home is left as it is."))),
});

/** A saved search's fields; on an update, a field left out keeps its value. */
const saved = {
  query: v.nullish(described(v.string(), "The query, in the query language.")),
  range: v.nullish(described(v.string(), "A window that ends now, as search's range takes it; null for from_ts and to_ts.")),
  from_ts: v.nullish(described(v.string(), "Where a fixed window starts, an ISO time; read only when range is null.")),
  to_ts: v.nullish(described(v.string(), "Where a fixed window ends, an ISO time; read only when range is null.")),
  agg: v.nullish(described(v.string(), "The series it reads, as search's agg takes it; null counts rows.")),
  widgets: v.nullish(described(v.unknown(), "The canvas: its widgets and their places, as the app saves them.")),
  board: v.nullish(described(v.unknown(), "A board's slots and window, as the app saves them; null makes it a plain hunt.")),
  cols: v.nullish(described(v.union([v.string(), v.array(v.string())]), "Attribute keys shown as columns, a list or separated by commas.")),
  pinned: v.nullish(described(v.boolean(), "Pinned for the caller; each person pins their own.")),
  // A shared that is not true or false is the handler's 403, as before.
  shared: v.optional(described(v.unknown(), "true or false: shared with everyone, or the caller's own; a Viewer's is their own.")),
};

export const savedCreateBody = v.object({
  name: described(v.string("name is required"), "Its name."),
  ...saved,
});

export const savedUpdateBody = v.object({
  name: v.nullish(described(v.string(), "Its name.")),
  ...saved,
});
