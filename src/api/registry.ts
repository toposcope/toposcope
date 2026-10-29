import type { Context, Handler, Next } from "hono";
import * as v from "valibot";
import type { Role } from "../control/people";
import { actionRole, type Action } from "../control/roles";

/**
 * The described API (#356): each `/api` route a token may call is one row of a table, and the
 * app, `GET /api/openapi.json`, `docs/api.md` and MCP (#358) all read that table. A row names
 * the role table's action the gate checks before the handler runs, one sentence on what the
 * route does, and the schemas of its query and its JSON body. The handler runs only once both
 * pass, so a body its schema refuses gets the one error shape below and never reaches it.
 */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** A query is flat: each key a string, or a list of strings for a key that repeats. */
export type QuerySchema = v.ObjectSchema<v.ObjectEntries, v.ErrorMessage<v.ObjectIssue> | undefined>;
export type BodySchema = v.GenericSchema;

export type ApiRoute = {
  /** Stable and unique: the OpenAPI operationId, and an MCP tool's name. */
  id: string;
  method: Method;
  /** Hono's pattern: `/api/monitors/:name`. */
  path: string;
  /** Where docs/api.md lists it, and its OpenAPI tag. */
  area: string;
  /** The role table's row (control/roles.ts): what the gate checks. */
  action: Action;
  /** One sentence on what it does. */
  summary: string;
  /** What its query takes; null when it reads none. Left out, a test fails. */
  query?: QuerySchema | null;
  /** What its JSON body takes; null when it reads none. Left out, a test fails. */
  body?: BodySchema | null;
  handler: Handler;
};

/** The one error shape: a sentence, and the input it is about when there is one. */
export type ApiError = { error: string; field?: string };

/** The least role that may call it, as the gate checks. */
export function roleOf(route: Pick<ApiRoute, "action">): Role {
  return actionRole[route.action];
}

/** Why a table is not one the app may register: a route with no schema, a duplicate, a bad path. */
export function routeProblems(routes: ApiRoute[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (!route.path.startsWith("/api/")) {
      problems.push(`${key}: not under /api/`);
    }
    if (seen.has(key)) {
      problems.push(`${key}: listed twice`);
    }
    seen.add(key);
    if (!/^[a-z][a-z0-9_]*$/.test(route.id) || ids.has(route.id)) {
      problems.push(`${key}: id ${route.id} is not snake_case or not unique`);
    }
    ids.add(route.id);
    if (route.query === undefined) {
      problems.push(`${key}: no query schema (null when it reads none)`);
    }
    if (route.body === undefined) {
      problems.push(`${key}: no body schema (null when it reads none)`);
    }
    if (route.method === "GET" && route.body) {
      problems.push(`${key}: a GET takes no body`);
    }
    if (!/^[A-Z].*\.$/.test(route.summary.trim())) {
      problems.push(`${key}: the summary is one sentence, capitalised, with a full stop`);
    }
  }
  return problems;
}

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) {
    return false;
  }
  return want.every((part, i) => (part.startsWith(":") ? got[i] !== "" : part === got[i]));
}

/** The row a request falls under, or null for a path no route serves (its 404 follows). */
export function routeFor<R extends { method: string; path: string }>(routes: R[], method: string, path: string): R | null {
  const verb = method === "HEAD" ? "GET" : method;
  // Fixed paths win over a `:param` on the same prefix (`/api/monitors/preview` over `:name`).
  return (
    routes.find((r) => r.method === verb && r.path === path) ??
    routes.find((r) => r.method === verb && r.path.includes(":") && matches(r.path, path)) ??
    null
  );
}

function isArraySchema(schema: v.GenericSchema): boolean {
  const inner = (schema as { wrapped?: v.GenericSchema }).wrapped ?? schema;
  return inner.type === "array";
}

/** The query as its schema reads it: a key that takes a list gets every value, any other its first. */
export function queryInput(c: Context, schema: QuerySchema): Record<string, string | string[]> {
  const all = c.req.queries();
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(all)) {
    const entry = schema.entries[key];
    out[key] = entry && isArraySchema(entry) ? values : values[0]!;
  }
  return out;
}

const notJson = Symbol("not JSON");

/** The body as JSON, read off a copy so the handler reads it as it always has; undefined when empty. */
async function bodyInput(c: Context): Promise<unknown> {
  const text = await c.req.raw.clone().text();
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return notJson;
  }
}

/** valibot's `("a" | "b")` or `Object` as words: `a or b`, `an object`. */
function words(expected: string | null): string {
  const plain = (expected ?? "something else").replace(/"/g, "").replace(/^\((.*)\)$/, "$1").replace(/ \| /g, " or ");
  return plain === "Object" ? "an object" : plain === "Array" ? "an array" : plain;
}

/** The sentence for valibot's own message; a schema's own words are used as they are. */
function sentence(issue: v.BaseIssue<unknown>, field: string | null, where: "query" | "body"): string {
  if (!issue.message.startsWith("Invalid ")) {
    return issue.message;
  }
  if (field === null) {
    if (where === "body" && issue.received === "undefined") {
      return "The body must be JSON";
    }
    return `The ${where} must be ${words(issue.expected)}, not ${issue.received}`;
  }
  if (issue.received === "undefined") {
    return `${field} is required`;
  }
  if (issue.kind === "schema") {
    return `${field} must be ${words(issue.expected)}, not ${issue.received}`;
  }
  // A length, a range, a pattern: valibot says which, after "Invalid ".
  return `${field}: ${issue.message.slice("Invalid ".length)}`;
}

/** The refusal for a schema's issues: the first one, as a sentence, with its field. */
export function refusal(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]], where: "query" | "body"): ApiError {
  const issue = issues[0];
  const field = v.getDotPath(issue);
  const error = sentence(issue, field, where);
  return field === null ? { error } : { error, field };
}

/** The handler the app registers: the query and the body checked against the row's schemas, then the row's own. */
export function checked(route: ApiRoute): Handler {
  return async (c: Context, next: Next) => {
    if (route.query) {
      const parsed = v.safeParse(route.query, queryInput(c, route.query));
      if (!parsed.success) {
        return c.json(refusal(parsed.issues, "query"), 400);
      }
    }
    if (route.body) {
      const raw = await bodyInput(c);
      if (raw === notJson) {
        return c.json({ error: "The body is not JSON" } satisfies ApiError, 400);
      }
      const parsed = v.safeParse(route.body, raw);
      if (!parsed.success) {
        return c.json(refusal(parsed.issues, "body"), 400);
      }
    }
    return route.handler(c, next);
  };
}

/**
 * Routes outside the table, each kept with its own page: they are not called with a token, or
 * they speak a protocol of their own. The spec and docs/api.md name them and link there.
 */
export const elsewhere: Array<{ name: string; doc: string; what: string; routes: string[] }> = [
  {
    name: "Sign-in",
    doc: "people.md",
    what: "A person signs in with a browser, by password or the provider, sets up the second step, and joins by invite or owner link; a token never calls these.",
    routes: [
      "POST /api/sign-in",
      "POST /api/sign-out",
      "POST /api/setup",
      "POST /api/join",
      "POST /api/two-step/verify",
      "POST /api/two-step/setup",
      "POST /api/two-step/finish",
      "GET /auth/start",
      "GET /auth/callback",
    ],
  },
  {
    name: "Ingest",
    doc: "ingest.md",
    what: "Senders write logs, metrics, traces, profiles, marks and check results with an ingest token, over OTLP or Toposcope's own JSON.",
    routes: ["POST /api/ingest", "POST /v1/logs", "POST /v1/metrics", "POST /v1/traces", "POST /v1/profiles", "POST /v1/marks", "POST /v1/probes", "POST /v1/checks", "GET /ping/{key}"],
  },
  {
    name: "Links between instances",
    doc: "access.md#links",
    what: "Another Toposcope pulls rows with a link's own secret, never a person's token.",
    routes: ["POST /link/v1/lookup", "POST /link/v1/claim", "GET /link/v1/feed", "POST /link/v1/remove", "POST /link/v1/ask", "POST /link/v1/rows"],
  },
  {
    name: "Shares, public side",
    doc: "shares.md",
    what: "A page or an app reads a share's counts and series with the share's secret or a ticket.",
    routes: ["POST /share/v1/tickets", "GET /share/v1/series", "GET /share/v1/top", "GET /share/v1/names", "GET /share/v1/panels/{name}"],
  },
  {
    name: "Open",
    doc: "operations.md",
    what: "Health and Prometheus metrics answer without signing in.",
    routes: ["GET /api/health", "GET /api/metrics"],
  },
];
