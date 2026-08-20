import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import {
  emptyFieldsCatalog,
  parseCheapKeys,
  parseFieldLinks,
  parseFieldRoles,
  parseFieldsWave,
  skipKeysFromRoles,
  type FieldRole,
  type FieldsConfig,
  type FieldsWave,
} from "../shared/fields";
import { syncFieldRoleSkip } from "../shared/migrate";
import {
  fieldsCatalog,
  fieldsCatalogKeys,
  fieldsCatalogSuggest,
  fieldsCatalogValues,
} from "../query/fields-catalog";
import { InvalidRangeError } from "../query/relative";
import { getDb } from "./index";

type RoleRow = { key: string; role: string };
type LinkRow = { log_key: string; metric_label: string };

export function readFieldConfig(database: Database = getDb()): FieldsConfig {
  const roles: Record<string, FieldRole> = {};
  const roleRows = database
    .query("SELECT key, role FROM field_roles")
    .all() as RoleRow[];
  for (const row of roleRows) {
    if (row.role === "lookup" || row.role === "ignore") {
      roles[row.key] = row.role;
    }
  }
  const links: Record<string, string> = {};
  const linkRows = database
    .query("SELECT log_key, metric_label FROM field_links")
    .all() as LinkRow[];
  for (const row of linkRows) {
    links[row.log_key] = row.metric_label;
  }
  return { roles, links };
}

export function writeFieldConfig(
  roles: Record<string, FieldRole>,
  links: Record<string, string>,
  database: Database = getDb(),
): FieldsConfig {
  database.run("BEGIN");
  try {
    database.run("DELETE FROM field_roles");
    database.run("DELETE FROM field_links");
    const insertRole = database.query(
      "INSERT INTO field_roles (key, role) VALUES (?, ?)",
    );
    for (const [key, role] of Object.entries(roles)) {
      insertRole.run(key, role);
    }
    const insertLink = database.query(
      "INSERT INTO field_links (log_key, metric_label) VALUES (?, ?)",
    );
    for (const [key, label] of Object.entries(links)) {
      insertLink.run(key, label);
    }
    database.run("COMMIT");
  } catch (err) {
    database.run("ROLLBACK");
    throw err;
  }
  return readFieldConfig(database);
}

export function storedSkipKeys(database: Database = getDb()): string[] {
  return skipKeysFromRoles(readFieldConfig(database).roles);
}

function windowFrom(c: Context): { from?: string; to?: string; range?: string } {
  return {
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    range: c.req.query("range") ?? undefined,
  };
}

function hasWindow(filters: { from?: string; to?: string; range?: string }): boolean {
  return Boolean(filters.range || filters.from || filters.to);
}

async function catalogWave(
  wave: FieldsWave,
  filters: { from?: string; to?: string; range?: string },
  cheap: string[],
) {
  switch (wave) {
    case "keys": {
      const keyed = await fieldsCatalogKeys(filters);
      return { ...emptyFieldsCatalog(), ...keyed };
    }
    case "values":
      return { values: await fieldsCatalogValues(filters) };
    case "suggest": {
      const suggest = await fieldsCatalogSuggest(filters, cheap);
      return suggest;
    }
    default: {
      const _never: never = wave;
      return _never;
    }
  }
}

export async function getFields(c: Context): Promise<Response> {
  const config = readFieldConfig();
  const filters = windowFrom(c);
  const wave = parseFieldsWave(c.req.query("wave") ?? undefined);
  if (wave && typeof wave === "object" && "error" in wave) {
    return c.json({ error: wave.error }, 400);
  }
  if (!hasWindow(filters)) {
    if (wave === "values") {
      return c.json({ values: {} });
    }
    if (wave === "suggest") {
      return c.json({
        metricLabels: [],
        suggestRoles: {},
        suggestLinks: {},
      });
    }
    return c.json({ ...config, ...emptyFieldsCatalog() });
  }
  try {
    if (wave === null) {
      const catalog = await fieldsCatalog(filters);
      return c.json({ ...config, ...catalog });
    }
    const payload = await catalogWave(
      wave,
      filters,
      parseCheapKeys(c.req.query("cheap") ?? undefined),
    );
    if (wave === "keys") {
      return c.json({ ...config, ...payload });
    }
    return c.json(payload);
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}

export async function putFields(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected an object" }, 400);
  }
  const rec = body as Record<string, unknown>;
  const roles = parseFieldRoles(rec.roles);
  if ("error" in roles) {
    return c.json({ error: roles.error }, 400);
  }
  const links = parseFieldLinks(rec.links);
  if ("error" in links) {
    return c.json({ error: links.error }, 400);
  }
  const stored = writeFieldConfig(roles, links);
  await syncFieldRoleSkip(skipKeysFromRoles(roles));
  return c.json(stored);
}
