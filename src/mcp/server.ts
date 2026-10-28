import type { Context } from "hono";
import { actorOf } from "../actor-context";
import { roleOf } from "../api/registry";
import { roleAtLeast } from "../control/people";
import { openedAddress } from "../shared/request-address";
import { publicUrl } from "../shared/public-url";
import { version } from "../shared/version";
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

function reply(c: Context, id: Id | null, answer: Answer, status: 200 | 400 = 200): Response {
  return c.json({ jsonrpc: "2.0", id, ...answer }, status);
}

function failure(code: number, message: string): Answer {
  return { error: { code, message } };
}

/** A browser on another site may not drive MCP here (the spec's DNS-rebinding rule); a client with no Origin may. */
function originAllowed(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) {
    return true;
  }
  try {
    const host = new URL(origin).host;
    const own = publicUrl();
    return host === openedAddress(c) || host === new URL(c.req.url).host || (own !== null && host === new URL(own).host);
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The route's answer as a tool's result: its JSON as text, an error when it was not 2xx. */
async function asResult(res: Response): Promise<unknown> {
  const text = await res.text();
  return { content: [{ type: "text", text }], isError: !res.ok };
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
        if ("error" in call) {
          return { result: { content: [{ type: "text", text: JSON.stringify(call) }], isError: true } };
        }
        // Not listed is not refused here: the route refuses, in its own words, what this token may not do.
        const url = new URL(call.path, c.req.url);
        url.search = call.query.toString();
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
        return { result: await asResult(res) };
      }
      default:
        return failure(rpcError.methodNotFound, `No method ${method} here: Toposcope answers initialize, ping, tools/list and tools/call`);
    }
  }

  return async (c: Context): Promise<Response> => {
    if (!originAllowed(c)) {
      return c.json({ error: "MCP here takes no calls from a page on another site" }, 403);
    }
    // Only a token: MCP speaks for a script or an agent, never a browser's session.
    if (actorOf(c)?.via !== "token") {
      return c.json({ error: "Send Authorization: Bearer with a personal or service account token" }, 401);
    }
    let message: unknown;
    try {
      message = JSON.parse(await c.req.text());
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
