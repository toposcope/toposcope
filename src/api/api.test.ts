import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import * as v from "valibot";
import { apiMarkdown } from "./docs";
import { toJsonSchema } from "./json-schema";
import { checked, routeProblems, type ApiRoute } from "./registry";
import { apiRoutes, openApi } from "./routes";

type Doc = Record<string, any>;

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const types = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const keywords = new Set([
  "type", "properties", "required", "additionalProperties", "items", "prefixItems", "minItems", "maxItems",
  "minLength", "maxLength", "minimum", "maximum", "pattern", "format", "enum", "const", "anyOf", "description",
  "title", "default", "$ref",
]);

/** A JSON Schema's problems: keywords 2020-12 does not have, types that are not types, required keys with no property. */
function schemaProblems(schema: unknown, at: string, out: string[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    out.push(`${at}: not a schema`);
    return;
  }
  const s = schema as Doc;
  for (const key of Object.keys(s)) {
    if (!keywords.has(key)) {
      out.push(`${at}: unknown keyword ${key}`);
    }
  }
  if (s.type !== undefined && !(typeof s.type === "string" ? types.has(s.type) : Array.isArray(s.type) && s.type.every((t: string) => types.has(t)))) {
    out.push(`${at}: type ${JSON.stringify(s.type)}`);
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((k: string) => !(k in (s.properties ?? {}))))) {
    out.push(`${at}: required names a key with no property`);
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    out.push(`${at}: enum is empty`);
  }
  for (const [key, inner] of Object.entries(s.properties ?? {})) {
    schemaProblems(inner, `${at}.properties.${key}`, out);
  }
  for (const [i, inner] of ((s.anyOf ?? []) as unknown[]).entries()) {
    schemaProblems(inner, `${at}.anyOf.${i}`, out);
  }
  for (const [i, inner] of ((s.prefixItems ?? []) as unknown[]).entries()) {
    schemaProblems(inner, `${at}.prefixItems.${i}`, out);
  }
  if (s.items !== undefined) {
    schemaProblems(s.items, `${at}.items`, out);
  }
  if (typeof s.additionalProperties === "object") {
    schemaProblems(s.additionalProperties, `${at}.additionalProperties`, out);
  }
}

/** OpenAPI 3.1's structure, as far as this spec uses it, with every $ref resolved. */
function openApiProblems(doc: Doc): string[] {
  const out: string[] = [];
  if (doc.openapi !== "3.1.0") out.push("openapi is not 3.1.0");
  if (typeof doc.info?.title !== "string" || typeof doc.info?.version !== "string") out.push("info needs a title and a version");
  const ids = new Set<string>();
  const tags = new Set((doc.tags ?? []).map((t: Doc) => t.name));
  for (const tag of doc.tags ?? []) {
    if (tag.externalDocs && !/^https:\/\//.test(tag.externalDocs.url)) out.push(`tag ${tag.name}: externalDocs.url`);
  }
  for (const [path, item] of Object.entries(doc.paths as Record<string, Doc>)) {
    if (!path.startsWith("/") || path.includes(":")) out.push(`${path}: a path starts with / and writes params as {name}`);
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!methods.has(method)) out.push(`${at}: not a method`);
      if (typeof op.operationId !== "string" || ids.has(op.operationId)) out.push(`${at}: operationId missing or repeated`);
      ids.add(op.operationId);
      if (typeof op.summary !== "string" || op.summary.length === 0) out.push(`${at}: no summary`);
      if (!["viewer", "operator", "owner"].includes(op["x-toposcope-role"])) out.push(`${at}: no role`);
      for (const tag of op.tags ?? []) if (!tags.has(tag)) out.push(`${at}: tag ${tag} is not listed`);
      if (!op.responses || Object.keys(op.responses).length === 0) out.push(`${at}: no responses`);
      for (const [code, res] of Object.entries(op.responses as Record<string, Doc>)) {
        if (!/^([1-5]XX|[1-5]\d\d|default)$/.test(code)) out.push(`${at}: response ${code}`);
        if (typeof res.description !== "string") out.push(`${at}: response ${code} has no description`);
        for (const media of Object.values((res.content ?? {}) as Record<string, Doc>)) schemaProblems(media.schema, `${at} ${code}`, out);
      }
      const seen = new Set<string>();
      for (const p of op.parameters ?? []) {
        if (typeof p.name !== "string" || !["query", "path", "header", "cookie"].includes(p.in)) out.push(`${at}: a parameter needs a name and an in`);
        if (seen.has(`${p.in}:${p.name}`)) out.push(`${at}: parameter ${p.name} twice`);
        seen.add(`${p.in}:${p.name}`);
        if (p.in === "path" && (p.required !== true || !templated.includes(p.name))) out.push(`${at}: path parameter ${p.name}`);
        schemaProblems(p.schema, `${at} ${p.name}`, out);
      }
      for (const name of templated) if (!seen.has(`path:${name}`)) out.push(`${at}: {${name}} is not a parameter`);
      if (op.requestBody) {
        const json = op.requestBody.content?.["application/json"];
        if (!json) out.push(`${at}: a body is JSON`);
        else schemaProblems(json.schema, `${at} body`, out);
      }
    }
  }
  const text = JSON.stringify(doc);
  for (const m of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
    const target = m[1]!.split("/").reduce<any>((node, key) => node?.[key], doc);
    if (target === undefined) out.push(`$ref #/${m[1]} resolves to nothing`);
  }
  for (const [name, scheme] of Object.entries((doc.components?.securitySchemes ?? {}) as Record<string, Doc>)) {
    if (scheme.type !== "http" || scheme.scheme !== "bearer") out.push(`securityScheme ${name}`);
  }
  return out;
}

describe("the described API (#356)", () => {
  test("every route in the table has a schema for its query and its body", () => {
    expect(routeProblems(apiRoutes)).toEqual([]);
  });

  test("a route registered without a schema is a problem", () => {
    const handler = () => new Response("ok");
    const route = { id: "x", method: "POST", path: "/api/x", area: "X", action: "read", summary: "Does x.", handler } as const;
    expect(routeProblems([route])).toEqual(["POST /api/x: no query schema (null when it reads none)", "POST /api/x: no body schema (null when it reads none)"]);
    expect(routeProblems([{ ...route, query: null, body: null }])).toEqual([]);
    expect(routeProblems([{ ...route, query: null, body: null }, { ...route, query: null, body: null }])).toHaveLength(2);
  });

  test("GET /api/openapi.json is OpenAPI 3.1, with every route and its role", () => {
    const doc = openApi() as Doc;
    expect(openApiProblems(doc)).toEqual([]);
    const ops = Object.values(doc.paths as Record<string, Doc>).flatMap((item) => Object.values(item));
    expect(ops).toHaveLength(apiRoutes.length);
    expect(doc.paths["/api/monitors/{name}"].put["x-toposcope-role"]).toBe("operator");
    expect(doc.paths["/api/settings"].put["x-toposcope-role"]).toBe("owner");
    expect(doc.tags.find((t: Doc) => t.name === "Sign-in").externalDocs.url).toEndWith("/docs/people.md");
  });

  test("the structural check catches a spec that is not 3.1", () => {
    const doc = structuredClone(openApi()) as Doc;
    doc.openapi = "3.0.3";
    doc.paths["/api/me"].get.parameters.push({ name: "x", in: "body" });
    doc.paths["/api/x/:id"] = { get: { operationId: "me", responses: {} } };
    expect(openApiProblems(doc).length).toBeGreaterThanOrEqual(4);
  });

  test("docs/api.md is what the table writes: run bun run api-docs", () => {
    const written = readFileSync(join(import.meta.dir, "../../docs/api.md"), "utf8");
    expect(written).toBe(apiMarkdown(apiRoutes));
  });

  test("a schema the spec cannot say throws, so a new kind is caught here", () => {
    expect(() => toJsonSchema(v.date())).toThrow("No JSON Schema for a valibot date schema");
    expect(toJsonSchema(v.optional(v.pipe(v.string(), v.maxLength(3), v.description("Short."))))).toEqual({ type: "string", maxLength: 3, description: "Short." });
    expect(toJsonSchema(v.object({ a: v.number(), b: v.nullish(v.boolean()) }))).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
      required: ["a"],
    });
  });
});

describe("a refused query or body (#356)", () => {
  let ran = 0;
  const route: ApiRoute = {
    id: "thing",
    method: "PUT",
    path: "/api/things/:id",
    area: "Things",
    action: "read",
    summary: "A thing.",
    query: v.object({ n: v.optional(v.pipe(v.string(), v.regex(/^\d+$/, "n is a whole number"))) }),
    body: v.object({ name: v.string(), tags: v.optional(v.array(v.string())), size: v.optional(v.picklist(["s", "m"])) }),
    handler: async (c) => {
      ran++;
      // The handler still reads the body itself, as it did before the schema.
      return c.json({ ok: true, body: await c.req.json() });
    },
  };
  const app = new Hono();
  app.on(route.method, route.path, checked(route));
  const put = (body: string, query = "") =>
    app.request(`/api/things/1${query}`, { method: "PUT", headers: { "content-type": "application/json" }, body });

  test("gets { error, field } and a 400, and the handler does not run", async () => {
    const cases: Array<[string, string, object]> = [
      [JSON.stringify({ name: 5 }), "", { error: "name must be string, not 5", field: "name" }],
      [JSON.stringify({}), "", { error: "name is required", field: "name" }],
      [JSON.stringify({ name: "a", tags: ["x", 2] }), "", { error: "tags.1 must be string, not 2", field: "tags.1" }],
      [JSON.stringify({ name: "a", size: "xl" }), "", { error: 'size must be s or m, not "xl"', field: "size" }],
      [JSON.stringify(42), "", { error: "The body must be an object, not 42" }],
      ["", "", { error: "The body must be JSON" }],
      ["{", "", { error: "The body is not JSON" }],
      [JSON.stringify({ name: "a" }), "?n=x", { error: "n is a whole number", field: "n" }],
    ];
    for (const [body, query, want] of cases) {
      const res = await put(body, query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(want);
    }
    expect(ran).toBe(0);
  });

  test("a body the schema takes reaches the handler whole, unknown keys and all", async () => {
    const res = await put(JSON.stringify({ name: "a", extra: 1 }), "?n=3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { name: "a", extra: 1 } });
    expect(ran).toBe(1);
  });
});
