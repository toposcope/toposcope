import { isOptional, toJsonSchema, type JsonSchema } from "./json-schema";
import { elsewhere, roleOf, type ApiRoute } from "./registry";

const docsBase = "https://github.com/toposcope/toposcope/blob/main/docs/";

const roleNames = { viewer: "Viewer", operator: "Operator", owner: "Owner" } as const;

/** `/api/monitors/:name` as OpenAPI writes it: `/api/monitors/{name}`. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

const errorSchema: JsonSchema = {
  type: "object",
  description: "Every refusal: a sentence, and the input it is about when there is one.",
  properties: {
    error: { type: "string", description: "What was wrong, as a sentence." },
    field: { type: "string", description: "The query key or the body's dotted path the sentence is about." },
  },
  required: ["error"],
};

function operation(route: ApiRoute): JsonSchema {
  const role = roleNames[roleOf(route)];
  const parameters: JsonSchema[] = pathParams(route.path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
  for (const [name, schema] of Object.entries(route.query?.entries ?? {})) {
    const json = toJsonSchema(schema);
    const { description, ...rest } = json;
    parameters.push({
      name,
      in: "query",
      required: !isOptional(schema),
      ...(typeof description === "string" ? { description } : {}),
      schema: rest,
      // A key that takes a list repeats: `keep=a&keep=b`.
      ...(rest.type === "array" ? { style: "form", explode: true } : {}),
    });
  }
  const refused = { description: "Refused", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  const out: JsonSchema = {
    operationId: route.id,
    summary: route.summary,
    description: `${route.summary} Role: ${role}.`,
    tags: [route.area],
    "x-toposcope-role": roleOf(route),
    parameters,
    responses: {
      "2XX": { description: "Done", content: { "application/json": { schema: {} } } },
      "400": { ...refused, description: "The query or the body is not what this route takes" },
      "401": { ...refused, description: "Not signed in, or the token is unknown" },
      "403": { ...refused, description: `Takes ${role === "Viewer" ? "a" : "an"} ${role}` },
      "4XX": refused,
    },
  };
  if (route.body) {
    out.requestBody = {
      required: !isOptional(route.body),
      content: { "application/json": { schema: toJsonSchema(route.body) } },
    };
  }
  return out;
}

/** The OpenAPI 3.1 document for the table, built once at start. */
export function openApiDocument(routes: ApiRoute[], version: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] ??= {};
    paths[path]![route.method.toLowerCase()] = operation(route);
  }
  const areas = [...new Set(routes.map((r) => r.area))];
  return {
    openapi: "3.1.0",
    info: {
      title: "Toposcope",
      version,
      description:
        "Every /api route a personal or service account token may call. Send it as Authorization: Bearer. " +
        "Each route names the least role that may call it. A refusal is { error, field? } with the route's status. " +
        "Routes for sign-in, ingest, links between instances, shares' public side and health keep their own pages: see the tags.",
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    tags: [
      ...areas.map((name) => ({ name })),
      ...elsewhere.map((group) => ({
        name: group.name,
        description: `${group.what} Not listed here: ${group.routes.join(", ")}.`,
        externalDocs: { url: docsBase + group.doc },
      })),
    ],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A personal or service account token from Access." } },
      schemas: { Error: errorSchema },
    },
  };
}
