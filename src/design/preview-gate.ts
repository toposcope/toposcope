import type { Context, Handler } from "hono";
import { actorOf } from "../actor-context";

/**
 * Preview first (#360): a monitor saved with a token (an agent's, or a script's) is refused unless
 * the same caller previewed the same body in the last 10 minutes. "The same body" is a canonical
 * hash of the normalized body with what it saves named in it: the monitor's name for a make or a
 * replace, its id for a change by id. Key order and spaces around text do not matter; any other
 * change does.
 *
 * A browser session is not held to it: the person is looking at the editor, and Watch this
 * already draws where the monitor would have opened. A token cannot be told apart as an agent's
 * or a script's, and both are better for it, so it holds for every token.
 *
 * Pausing and silencing (`enabled`, `silence_for`, `silenced_until`) are what an operator does to
 * a monitor, not what it is: a body with only those is not held, and they are left out of the hash.
 * A body the save refuses anyway is not held either, so its refusal stays the route's own.
 */
export const previewMs = 10 * 60_000;

/** The tool, and the route, that previews a monitor's body. */
export const previewTool = "monitor_draft_preview";
const previewRoute = "POST /api/monitors/preview";

export const holdKeys = ["enabled", "silence_for", "silenced_until"] as const;

/** What a save saves: a monitor by name (a make or a replace), or by id (a change). */
export type Target = { name: string } | { id: string };

/** Text trimmed, keys sorted, `undefined` left out; null, numbers and booleans as they are. */
export function normalized(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) {
        out[key] = normalized(inner);
      }
    }
    return out;
  }
  return value;
}

/** A monitor's body as the gate reads it: what it saves named in it, the hold keys out. */
export function monitorDraft(body: Record<string, unknown>, target: Target): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  delete out["id" in target ? "id" : "name"];
  for (const key of holdKeys) {
    delete out[key];
  }
  return { ...out, ...target };
}

export function bodyHash(body: Record<string, unknown>, target: Target): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(normalized(monitorDraft(body, target))));
  return hasher.digest("hex");
}

function targetKey(target: Target): string {
  return "id" in target ? `id:${target.id}` : `name:${target.name.trim()}`;
}

type Seen = { at: number; target: string };
/** Previews by caller, then by hash. Kept in the process: after a restart, preview again. */
const previews = new Map<string, Map<string, Seen>>();
/** The bodies an undo puts back, by caller: an undo is a body that was, so it needs no preview. */
const undos = new Map<string, Set<string>>();
const mostPerCaller = 500;

/** A preview of this body by this caller, now. */
export function notePreview(callerId: string, body: Record<string, unknown>, target: Target, now = Date.now()): { hash: string; until: number } {
  const hash = bodyHash(body, target);
  const mine = previews.get(callerId) ?? new Map<string, Seen>();
  mine.delete(hash);
  mine.set(hash, { at: now, target: targetKey(target) });
  // A stale one is kept a while past when it counts, so the refusal can say it was stale.
  for (const [h, seen] of mine) {
    if (now - seen.at > 6 * previewMs) {
      mine.delete(h);
    }
  }
  while (mine.size > mostPerCaller) {
    mine.delete(mine.keys().next().value!);
  }
  previews.set(callerId, mine);
  return { hash, until: now + previewMs };
}

/** The body an undo will put back, so that exact call is let through without a preview. */
export function noteUndo(callerId: string, body: Record<string, unknown>, target: Target): void {
  const mine = undos.get(callerId) ?? new Set<string>();
  mine.add(bodyHash(body, target));
  while (mine.size > mostPerCaller) {
    mine.delete(mine.values().next().value!);
  }
  undos.set(callerId, mine);
}

/** Why this save is refused, or null when its body was previewed in time (or is an undo). */
export function previewProblem(callerId: string, body: Record<string, unknown>, target: Target, now = Date.now()): string | null {
  const hash = bodyHash(body, target);
  if (undos.get(callerId)?.has(hash)) {
    return null;
  }
  const mine = previews.get(callerId);
  const seen = mine?.get(hash);
  if (seen && now - seen.at <= previewMs) {
    return null;
  }
  const with_ = "id" in target ? "its id" : "its name";
  const how = `call ${previewTool} (${previewRoute}) with this same body and ${with_} in it, then save it within 10 minutes`;
  if (seen) {
    return `This monitor's preview is more than 10 minutes old: ${how}`;
  }
  const key = targetKey(target);
  const other = mine ? [...mine.values()].some((s) => s.target === key && now - s.at <= previewMs) : false;
  if (other) {
    return `This body is not the one previewed: it changed since. To save it, ${how}`;
  }
  return `A monitor saved with a token is previewed first: ${how}`;
}

async function bodyOf(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.raw.clone().json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a route that makes or changes a monitor. `targetOf` names what the save saves; `saves`
 * says whether the route would save this body at all (the preview's own check), so a body it
 * refuses goes through to be refused in the route's words.
 */
export function previewFirst(
  handler: Handler,
  targetOf: (c: Context, body: Record<string, unknown>) => Target | null,
  saves: (c: Context, body: Record<string, unknown>, target: Target) => boolean,
): Handler {
  return async (c, next) => {
    const actor = actorOf(c);
    if (actor?.via !== "token") {
      return handler(c, next);
    }
    const body = await bodyOf(c);
    if (!body || Object.keys(body).every((key) => (holdKeys as readonly string[]).includes(key))) {
      return handler(c, next);
    }
    const target = targetOf(c, body);
    if (!target || !saves(c, body, target)) {
      return handler(c, next);
    }
    const problem = previewProblem(actor.person.id, body, target);
    if (problem) {
      return c.json({ error: problem, preview: { tool: previewTool, arguments: { body: { ...monitorDraft(body, target), ...pick(body, holdKeys) } } } }, 428);
    }
    return handler(c, next);
  };
}

function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
}
