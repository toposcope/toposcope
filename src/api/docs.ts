import { isOptional, toJsonSchema, type JsonSchema } from "./json-schema";
import { openApiPath, pathParams } from "./openapi";
import { elsewhere, roleOf, type ApiRoute } from "./registry";

const roleNames = { viewer: "Viewer", operator: "Operator", owner: "Owner" } as const;

/** A JSON Schema in a table cell's words: `string`, `"a" \| "b"`, `string[]`, `object`. */
function typeWords(schema: JsonSchema): string {
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" \\| ");
  }
  if (Array.isArray(schema.anyOf)) {
    return [...new Set((schema.anyOf as JsonSchema[]).map(typeWords))].join(" \\| ");
  }
  if (schema.type === "array") {
    const item = typeWords((schema.items as JsonSchema | undefined) ?? {});
    return item.includes(" ") ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object" && !schema.properties) {
    return `{ [key]: ${typeWords(schema.additionalProperties as JsonSchema)} }`;
  }
  return typeof schema.type === "string" ? schema.type : "any";
}

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The object a field holds, or a list of: looked for through a null it may also be. */
function nested(schema: JsonSchema): { object: JsonSchema; list: boolean } | null {
  for (const variant of Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [schema]) {
    const list = variant.type === "array";
    const object = list ? (variant.items as JsonSchema | undefined) : variant;
    if (object?.type === "object" && object.properties) {
      return { object, list };
    }
  }
  return null;
}

function fieldRows(entries: Array<[string, JsonSchema, boolean]>, prefix = ""): string[] {
  const rows: string[] = [];
  for (const [name, schema, required] of entries) {
    const description = typeof schema.description === "string" ? schema.description : "";
    rows.push(`| \`${prefix}${name}\` | ${typeWords(schema)} | ${required ? "yes" : ""} | ${cell(description)} |`);
    // One level of nesting is spelled out; deeper shapes are in /api/openapi.json.
    const shape = nested(schema);
    if (!prefix && shape) {
      const props = Object.entries(shape.object.properties as Record<string, JsonSchema>);
      const req = new Set((shape.object.required as string[] | undefined) ?? []);
      rows.push(...fieldRows(props.map(([k, s]) => [k, s, req.has(k)]), `${name}${shape.list ? "[]" : ""}.`));
    }
  }
  return rows;
}

const header = ["| Field | Type | Required | What |", "| --- | --- | --- | --- |"];

function routeSection(route: ApiRoute): string[] {
  const lines = [`### ${route.method} ${openApiPath(route.path)}`, "", route.summary, "", `Role: **${roleNames[roleOf(route)]}** · \`${route.id}\``, ""];
  const params = pathParams(route.path);
  if (params.length > 0) {
    lines.push(`Path: ${params.map((p) => `\`${p}\``).join(", ")}.`, "");
  }
  const query = Object.entries(route.query?.entries ?? {});
  if (query.length > 0) {
    lines.push("Query:", "", ...header, ...fieldRows(query.map(([k, s]) => [k, toJsonSchema(s), !isOptional(s)])), "");
  }
  if (route.body) {
    const body = toJsonSchema(route.body);
    const object = Array.isArray(body.anyOf) ? undefined : body;
    if (object?.type === "object" && object.properties && Object.keys(object.properties).length > 0) {
      const req = new Set((object.required as string[] | undefined) ?? []);
      const props = Object.entries(object.properties as Record<string, JsonSchema>);
      lines.push(`Body${isOptional(route.body) ? ", optional" : ""}:`, "", ...header, ...fieldRows(props.map(([k, s]) => [k, s, req.has(k)])), "");
    } else {
      lines.push(`Body${isOptional(route.body) ? ", optional" : ""}: ${typeWords(body)}.`, "");
    }
  }
  return lines;
}

/** docs/api.md, from the table. `bun run api-docs` writes it; a test fails when it drifts. */
export function apiMarkdown(routes: ApiRoute[]): string {
  const areas = [...new Set(routes.map((r) => r.area))];
  const lines = [
    "# API",
    "",
    "<!-- Written by `bun run api-docs` from src/api/routes.ts. Do not edit by hand. -->",
    "",
    "Every `/api` route a personal or service account token may call, from the same table the app registers its routes from. `GET /api/openapi.json` is this page as OpenAPI 3.1.",
    "",
    "Send the token as `Authorization: Bearer <token>`; a browser's session works too. Each route names the least role that may call it ([People and roles](people.md)). A query value is text; a body is JSON.",
    "",
    "A refusal is one shape, with the route's status: `{ \"error\": \"<sentence>\", \"field\": \"<path>\" }`, `field` only when the sentence is about one input. A query or a body the route does not take is a 400 and the route does not run. A role refusal is a 403 that also names the role it needs, `need`.",
    "",
    "## Elsewhere",
    "",
    "These keep their own pages and are not in the spec:",
    "",
    ...elsewhere.map((group) => `- **${group.name}** ([${group.doc.split("#")[0]}](${group.doc})): ${group.what} ${group.routes.map((r) => `\`${r}\``).join(", ")}.`),
    "",
  ];
  for (const area of areas) {
    lines.push(`## ${area}`, "");
    for (const route of routes.filter((r) => r.area === area)) {
      lines.push(...routeSection(route));
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
