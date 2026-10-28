import type * as v from "valibot";

/** JSON Schema (2020-12, as OpenAPI 3.1 takes it), as far as the API's schemas need. */
export type JsonSchema = { [key: string]: unknown };

type Node = v.GenericSchema & {
  entries?: Record<string, Node>;
  item?: Node;
  items?: Node[];
  options?: Array<Node | string | number>;
  wrapped?: Node;
  key?: Node;
  value?: Node;
  literal?: unknown;
  rest?: Node;
  default?: unknown;
  pipe?: Array<{ kind: string; type: string; requirement?: unknown; description?: string; title?: string }>;
};

/** A schema that may be left out of its object. */
export function isOptional(schema: v.GenericSchema): boolean {
  return schema.type === "optional" || schema.type === "exact_optional" || schema.type === "nullish" || schema.type === "undefinedable";
}

function base(schema: Node): JsonSchema {
  switch (schema.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "unknown":
    case "any":
      return {};
    case "literal":
      return { const: schema.literal };
    case "picklist":
      return { enum: schema.options };
    case "array":
      return { type: "array", items: toJsonSchema(schema.item!) };
    case "tuple":
      return { type: "array", prefixItems: schema.items!.map(toJsonSchema), minItems: schema.items!.length, maxItems: schema.items!.length };
    case "record":
      return { type: "object", additionalProperties: toJsonSchema(schema.value!) };
    case "object":
    case "loose_object":
    case "strict_object":
    case "object_with_rest": {
      const entries = Object.entries(schema.entries ?? {});
      const out: JsonSchema = {
        type: "object",
        properties: Object.fromEntries(entries.map(([key, value]) => [key, toJsonSchema(value)])),
      };
      const required = entries.filter(([, value]) => !isOptional(value)).map(([key]) => key);
      if (required.length > 0) {
        out.required = required;
      }
      if (schema.type === "strict_object") {
        out.additionalProperties = false;
      } else if (schema.type === "object_with_rest") {
        out.additionalProperties = toJsonSchema(schema.rest!);
      }
      return out;
    }
    case "union":
    case "variant":
      return { anyOf: (schema.options as Node[]).map(toJsonSchema) };
    case "optional":
    case "exact_optional":
    case "undefinedable": {
      const inner = toJsonSchema(schema.wrapped!);
      const fallback = schema.default;
      return fallback === undefined || typeof fallback === "function" ? inner : { ...inner, default: fallback };
    }
    case "nullable":
    case "nullish": {
      // What the value means is said once, beside the null it may also be.
      const { description, ...inner } = toJsonSchema(schema.wrapped!);
      return { anyOf: [inner, { type: "null" }], ...(description === undefined ? {} : { description }) };
    }
    default:
      throw new Error(`No JSON Schema for a valibot ${schema.type} schema`);
  }
}

/** What a pipe adds: lengths, ranges, a pattern, a description. Checks it cannot say are left out. */
function applyPipe(out: JsonSchema, schema: Node): JsonSchema {
  for (const step of schema.pipe?.slice(1) ?? []) {
    const n = step.requirement;
    const many = out.type === "array";
    switch (step.type) {
      case "description":
        out.description = step.description;
        break;
      case "title":
        out.title = step.title;
        break;
      case "integer":
        out.type = "integer";
        break;
      case "min_length":
        out[many ? "minItems" : "minLength"] = n;
        break;
      case "max_length":
        out[many ? "maxItems" : "maxLength"] = n;
        break;
      case "length":
        out[many ? "minItems" : "minLength"] = n;
        out[many ? "maxItems" : "maxLength"] = n;
        break;
      case "non_empty":
        out[many ? "minItems" : "minLength"] = 1;
        break;
      case "min_value":
        out.minimum = n;
        break;
      case "max_value":
        out.maximum = n;
        break;
      case "regex":
        out.pattern = (n as RegExp).source;
        break;
      case "email":
        out.format = "email";
        break;
      case "url":
        out.format = "uri";
        break;
      case "iso_timestamp":
      case "iso_date_time":
        out.format = "date-time";
        break;
      case "finite":
      case "check":
      case "trim":
      case "transform":
      case "to_lower_case":
        break;
      default:
        throw new Error(`No JSON Schema for a valibot ${step.type} action`);
    }
  }
  return out;
}

/** The JSON Schema of a valibot schema. A schema or an action it cannot say throws, so a test catches it. */
export function toJsonSchema(schema: v.GenericSchema): JsonSchema {
  const node = schema as Node;
  return applyPipe(base(node), node);
}

/** A schema's description, from its pipe or, for an optional, from what it wraps. */
export function describe(schema: v.GenericSchema): string | undefined {
  const out = toJsonSchema(schema);
  return typeof out.description === "string" ? out.description : undefined;
}
