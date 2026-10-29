import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { roleOf } from "../api/registry";
import { roleAtLeast } from "../control/people";
import { publicUrl } from "../shared/public-url";
import { version } from "../shared/version";
import { capArgs, capsOf, fenced, readTools, shapeRead, unfencedTools, type Caps } from "./read";
import { toolCall, type McpTool } from "./tools";

/**
 * MCP at `/mcp` (#358): JSON-RPC 2.0 over Streamable HTTP, stateless, answered as JSON. There is no
 * session and no stream: each POST carries one message, a request gets its response in the reply, and
 * a notification or a response gets 202. The caller is the API's own: the gate in index.ts has
 * already checked the Bearer token, and each tool runs its route in-process with that same header.
 */

/** The revisions this answers, newest first; `initialize` agrees on the client's when it is here, else the newest. */
export const protocolVersions = ["2025-11-25", "2025-06-18"];

type Id = string | number;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Answer = { result: unknown } | { error: { code: number; message: string } };

export const rpcError = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function reply(c: Context, id: Id | null, answer: Answer, status: 200 | 400 | 413 = 200): Response {
  return c.json({ jsonrpc: "2.0", id, ...answer }, status);
}

function failure(code: number, message: string): Answer {
  return { error: { code, message } };
}

/** The most a POST to /mcp may carry. */
export const maxBodyBytes = 1024 * 1024;
/** How deep a message's params may nest. */
export const maxDepth = 64;

/**
 * A browser page may drive MCP here only from this instance's own address: TOPOSCOPE_PUBLIC_URL, or
 * localhost on the port the app listens on. Never the request's Host, which a DNS-rebinding page
 * sets to its own name. A client with no Origin (a CLI, an agent) is not a page and may.
 */
export function originAllowed(origin: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (origin === undefined) {
    return true;
  }
  let given: URL;
  try {
    given = new URL(origin);
  } catch {
    return false;
  }
  const own = publicUrl(env);
  if (own !== null && given.origin === new URL(own).origin) {
    return true;
  }
  const port = env.PORT ?? "8080";
  return given.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(given.hostname) && given.port === port;
}

/** Deeper than `limit`, counted without recursion so a deep message cannot overflow the stack. */
export function nestedDeeper(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (typeof node !== "object" || node === null) {
      continue;
    }
    if (depth > limit) {
      return true;
    }
    for (const child of Object.values(node)) {
      stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** The body as text, or null once it passes `max` bytes: read no further than that, whatever Content-Length says. */
async function cappedText(request: Request, max: number): Promise<string | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The route's answer as a tool's result: its JSON as text, an error when it was not 2xx. Every
 * tool's 2xx answer is fenced first (read.ts): under `data` beside the note that it is stored or
 * sent text, and on the instance's clock; a read tool's is capped too. A refusal is the route's
 * own sentence.
 */
async function asResult(res: Response, tool: McpTool, args: Record<string, unknown>, caps: Caps | null): Promise<unknown> {
  const text = await res.text();
  if (!res.ok || unfencedTools.has(tool.name)) {
    return { content: [{ type: "text", text }], isError: !res.ok };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  const read = readTools[tool.name];
  let shaped;
  if (read && caps) {
    const own = Object.fromEntries(Object.entries(args).filter(([key]) => !(capArgs as readonly string[]).includes(key)));
    const takes = Object.keys((tool.inputSchema.properties ?? {}) as object);
    shaped = shapeRead({ tool: tool.name, read, args: own, caps, json, takes });
  } else {
    shaped = fenced(json);
  }
  return { content: [{ type: "text", text: JSON.stringify(shaped) }], isError: false };
}

/** `POST /mcp`. `run` is the app itself, so a tool's request meets the same gate and handler as the API. */
export function mcpRoute(tools: McpTool[], run: (request: Request) => Response | Promise<Response>) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function answer(c: Context, method: string, params: Record<string, unknown>): Promise<Answer> {
    switch (method) {
      case "initialize": {
        if (typeof params.protocolVersion !== "string") {
          return failure(rpcError.invalidParams, "initialize needs params.protocolVersion");
        }
        const agreed = protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0];
        return {
          result: {
            protocolVersion: agreed,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "toposcope", title: "Toposcope", version },
            instructions: "Each tool runs one route of Toposcope's API with your token, so it may do what your role may do there and no more.",
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list": {
        const actor = actorOf(c);
        const mine = tools.filter((t) => actor !== null && roleAtLeast(actor.role, roleOf(t.route)));
        return {
          result: {
            tools: mine.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.route.method === "GET" ? { annotations: { readOnlyHint: true } } : {}),
            })),
          },
        };
      }
      case "tools/call": {
        const tool = typeof params.name === "string" ? byName.get(params.name) : undefined;
        if (!tool) {
          return failure(rpcError.invalidParams, `No tool ${typeof params.name === "string" ? params.name : "named"}: tools/list says which there are`);
        }
        const args = params.arguments ?? {};
        if (!isObject(args)) {
          return failure(rpcError.invalidParams, "arguments must be an object");
        }
        const call = toolCall(tool, args);
        const caps = readTools[tool.name] ? capsOf(args) : null;
        if (caps && "error" in caps) {
          return { result: { content: [{ type: "text", text: JSON.stringify(caps) }], isError: true } };
        }
        if ("error" in call) {
          return { result: { content: [{ type: "text", text: JSON.stringify(call) }], isError: true } };
        }
        // Not listed is not refused here: the route refuses, in its own words, what this token may not do.
        // The path is joined, not resolved against the request's, and a path the URL parser would
        // still change (a dot segment) is refused, so a tool reaches its own route and no other.
        const search = call.query.toString();
        const url = new URL(`${new URL(c.req.url).origin}${call.path}${search ? `?${search}` : ""}`);
        if (url.pathname !== call.path) {
          return { result: { content: [{ type: "text", text: JSON.stringify({ error: `${tool.name}: a path param may not be a path` }) }], isError: true } };
        }
        const headers = new Headers();
        for (const name of ["authorization", "host", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"]) {
          const value = c.req.header(name);
          if (value !== undefined) {
            headers.set(name, value);
          }
        }
        if (call.body !== undefined) {
          headers.set("content-type", "application/json");
        }
        const res = await run(new Request(url, { method: call.method, headers, body: call.body }));
        return { result: await asResult(res, tool, args, caps) };
      }
      default:
        return failure(rpcError.methodNotFound, `No method ${method} here: Toposcope answers initialize, ping, tools/list and tools/call`);
    }
  }

  return async (c: Context): Promise<Response> => {
    if (!originAllowed(c.req.header("origin"))) {
      return c.json({ error: "MCP here takes no calls from a page on another site" }, 403);
    }
    // Only a token: MCP speaks for a script or an agent, never a browser's session.
    if (actorOf(c)?.via !== "token") {
      return c.json({ error: "Send Authorization: Bearer with a personal or service account token" }, 401);
    }
    const text = await cappedText(c.req.raw, maxBodyBytes);
    if (text === null) {
      return reply(c, null, failure(rpcError.invalidRequest, `A message is at most ${maxBodyBytes} bytes`), 413);
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return reply(c, null, failure(rpcError.parse, "The body is not JSON"), 400);
    }
    if (Array.isArray(message)) {
      return reply(c, null, failure(rpcError.invalidRequest, "One message per POST: MCP has had no batches since 2025-06-18"), 400);
    }
    if (!isObject(message) || (message as Message).jsonrpc !== "2.0") {
      return reply(c, null, failure(rpcError.invalidRequest, 'A message is a JSON-RPC 2.0 object, with jsonrpc "2.0"'), 400);
    }
    const m = message as Message;
    const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
    if (m.method === undefined && (m.result !== undefined || m.error !== undefined) && id !== null) {
      // A client's response to a request this server never sends: taken, and nothing follows.
      return c.body(null, 202);
    }
    if (typeof m.method !== "string") {
      return reply(c, id, failure(rpcError.invalidRequest, "A message names its method"), 400);
    }
    if (m.id === undefined) {
      // A notification (initialized, cancelled): nothing to answer.
      return c.body(null, 202);
    }
    if (id === null) {
      return reply(c, null, failure(rpcError.invalidRequest, "A request's id is a string or a number"), 400);
    }
    const asked = c.req.header("mcp-protocol-version");
    if (asked !== undefined && m.method !== "initialize" && !protocolVersions.includes(asked)) {
      return reply(c, id, failure(rpcError.invalidRequest, `MCP-Protocol-Version ${asked} is not one this answers: ${protocolVersions.join(", ")}`), 400);
    }
    if (m.params !== undefined && !isObject(m.params)) {
      return reply(c, id, failure(rpcError.invalidParams, "params must be an object"));
    }
    if (nestedDeeper(m.params, maxDepth)) {
      return reply(c, id, failure(rpcError.invalidParams, `params nest at most ${maxDepth} deep`));
    }
    try {
      return reply(c, id, await answer(c, m.method, (m.params as Record<string, unknown> | undefined) ?? {}));
    } catch (err) {
      console.error("mcp", err);
      return reply(c, id, failure(rpcError.internal, err instanceof Error ? err.message.slice(0, 500) : "Internal error"));
    }
  };
}

/** `GET` and `DELETE /mcp`: no stream to open and no session to end. */
export function mcpNotHere(c: Context): Response {
  return c.json({ error: "MCP here is POST only: there are no server-sent streams and no sessions" }, 405, { allow: "POST" });
}
