import type { Context } from "hono";

/**
 * What every design write answers with (#360), beside what its route answers: its id, where it
 * is in the app (a path on this instance), and the one call that undoes it. `tool` is a route's
 * id, which is its MCP tool's name; `arguments` are that tool's, as `tools/call` takes them.
 */
export type Undo = { tool: string; arguments: Record<string, unknown>; does: string };
export type Made = { id?: string; link: string; undo: Undo };

/** A 2xx JSON object answer with `made` folded in; anything else as it was. */
export async function answerWith(res: Response, made: () => Made | Promise<Made>): Promise<Response> {
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) {
    return res;
  }
  const body: unknown = await res.clone().json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, ...(await made()) }), { status: res.status, headers });
}

/** The JSON body as an object, read off a copy; a Response when it is not one. */
export async function readObject(c: Context): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return c.json({ error: "The body is not JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "The body must be an object" }, 400);
  }
  return body as Record<string, unknown>;
}
