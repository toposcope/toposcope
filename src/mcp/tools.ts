import { pathParams } from "../api/openapi";
import { isOptional, toJsonSchema, type JsonSchema } from "../api/json-schema";
import type { ApiError, ApiRoute } from "../api/registry";
import { apiRoutes } from "../api/routes";

/**
 * MCP's tools (#358): each one stands for one row of the described API and runs it, so its name
 * is the route's id, its description the route's summary, and its input the route's own: the path's
 * params and the query's keys at the top, and the JSON body, when the route takes one, under `body`.
 */
export type McpTool = {
  name: string;
  route: ApiRoute;
  description: string;
  inputSchema: JsonSchema;
};

/**
 * The routes MCP offers, by id, in the order `tools/list` shows them. A tool is one more id here;
 * the read tools (#359) and the design tools (#360) add theirs.
 */
export const toolRouteIds: string[] = [
  "search",
  "saved_searches",
  "saved_search_run",
  "saved_search_test",
  "monitors",
  "monitor_get",
  "marks",
  "attr_keys",
  "attr_values",
  "metric_names",
];

/** The tool for a route. A path param, a query key and `body` share one namespace, so a clash throws. */
export function toolOf(route: ApiRoute): McpTool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const add = (key: string, schema: JsonSchema, need: boolean) => {
    if (key in properties) {
      throw new Error(`${route.id}: ${key} is both a path param and a query key, or is named body`);
    }
    properties[key] = schema;
    if (need) {
      required.push(key);
    }
  };
  for (const name of pathParams(route.path)) {
    add(name, { type: "string", description: `The ${name} in ${route.path}.` }, true);
  }
  const query = route.query ? toJsonSchema(route.query) : null;
  for (const [key, schema] of Object.entries((query?.properties ?? {}) as Record<string, JsonSchema>)) {
    add(key, schema, ((query?.required ?? []) as string[]).includes(key));
  }
  if (route.body) {
    add("body", toJsonSchema(route.body), !isOptional(route.body));
  }
  const inputSchema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) {
    inputSchema.required = required;
  }
  return { name: route.id, route, description: route.summary, inputSchema };
}

/** The tools for some route ids; an id the table does not have throws, so a typo stops the start. */
export function toolsOf(ids: string[], routes: ApiRoute[] = apiRoutes): McpTool[] {
  return ids.map((id) => {
    const route = routes.find((r) => r.id === id);
    if (!route) {
      throw new Error(`No API route ${id} for an MCP tool`);
    }
    return toolOf(route);
  });
}

/** The tools MCP offers, built at start. */
export const mcpTools: McpTool[] = toolsOf(toolRouteIds);

export type ToolCall = { method: string; path: string; query: URLSearchParams; body: string | undefined };

function queryValue(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

/**
 * A tool's arguments as the request its route takes. What the route's schemas would refuse is left
 * for the route to refuse in its own words; only what has no place in the request is refused here.
 */
export function toolCall(tool: McpTool, args: Record<string, unknown>): ToolCall | ApiError {
  const params = pathParams(tool.route.path);
  const queryKeys = Object.keys(tool.route.query?.entries ?? {});
  for (const key of Object.keys(args)) {
    if (!params.includes(key) && !queryKeys.includes(key) && !(key === "body" && tool.route.body)) {
      return { error: `${tool.name} takes no ${key}`, field: key };
    }
  }
  let path = tool.route.path;
  for (const name of params) {
    const value = queryValue(args[name]);
    if (value === null || value === "") {
      return { error: `${name} is required`, field: name };
    }
    // Each is one segment of the route's path: never a dot segment or a path of its own.
    if (value === "." || value === ".." || value.includes("/")) {
      return { error: `${name} may not be . or .. or hold a /`, field: name };
    }
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  const query = new URLSearchParams();
  for (const key of queryKeys) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    for (const one of Array.isArray(value) ? value : [value]) {
      const text = queryValue(one);
      if (text === null) {
        return { error: `${key} must be a string`, field: key };
      }
      query.append(key, text);
    }
  }
  const body = args.body === undefined ? undefined : JSON.stringify(args.body);
  return { method: tool.route.method, path, query, body };
}
