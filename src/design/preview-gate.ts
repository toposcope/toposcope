import type { Context, Handler } from "hono";
import { actorOf } from "../actor-context";
import { holdKeys, isHoldOnly } from "../control/alerts";

export { holdKeys };

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
 * a monitor, not what it is: they are left out of the hash, and a body with only those is not held
 * where the route keeps every other field (a change by id, or a replace of a monitor that exists,
 * which then only pauses or silences it). A body the save would refuse is refused here, in the
 * draft's words, and never passed on: the gate and the save read it the same way or not at all.
 *
 * "The same caller" is the same person or service account, whichever of its tokens it used.
 */
export const previewMs = 10 * 60_000;

/** The tool, and the route, that previews a monitor's body. */
export const previewTool = "monitor_draft_preview";
const previewRoute = "POST /api/monitors/preview";


/**
 * What a save saves: a monitor by name, as a replace (`PUT /api/monitors/:name`) or a make
 * (`POST /api/alert-rules`, which may make a second of one name), or by id (a change). A replace's
 * preview does not unlock a make, nor a make's a replace.
 */
export type Target = { name: string; saves: "replace" | "create" } | { id: string };

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
  delete out.saves;
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
  return "id" in target ? `id:${target.id}` : `${target.saves}:${target.name.trim()}`;
}

type Seen = { at: number; target: string };
/** Previews by caller, then by hash. Kept in the process: after a restart, preview again. */
const previews = new Map<string, Map<string, Seen>>();
/** The bodies an undo puts back, by caller, and when: an undo is a body that was, so for 10 minutes it needs no preview. */
const undos = new Map<string, Map<string, number>>();
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

/** The body an undo will put back, so for 10 minutes that exact call is let through without a preview. */
export function noteUndo(callerId: string, body: Record<string, unknown>, target: Target, now = Date.now()): void {
  const mine = undos.get(callerId) ?? new Map<string, number>();
  const hash = bodyHash(body, target);
  mine.delete(hash);
  mine.set(hash, now);
  for (const [h, at] of mine) {
    if (now - at > previewMs) {
      mine.delete(h);
    }
  }
  while (mine.size > mostPerCaller) {
    mine.delete(mine.keys().next().value!);
  }
  undos.set(callerId, mine);
}

/** Why this save is refused, or null when its body was previewed in time (or is an undo). */
export function previewProblem(callerId: string, body: Record<string, unknown>, target: Target, now = Date.now()): string | null {
  const hash = bodyHash(body, target);
  const undoAt = undos.get(callerId)?.get(hash);
  if (undoAt !== undefined && now - undoAt <= previewMs) {
    return null;
  }
  const mine = previews.get(callerId);
  const seen = mine?.get(hash);
  if (seen && now - seen.at <= previewMs) {
    return null;
  }
  const with_ = "id" in target ? "its id" : target.saves === "create" ? 'its name and saves: "create"' : "its name";
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

/** What the gate needs of a route: what it saves, how the draft reads, and whether a pause there keeps the rest. */
export type Gate = {
  targetOf: (c: Context, body: Record<string, unknown>) => Target;
  draft: (body: Record<string, unknown>, target: Target) => { ok: true } | { ok: false; error: string; status: 400 | 404 | 409; field?: string };
  holdKeepsRest: (target: Target) => boolean;
};

/**
 * Wraps a route that makes or changes a monitor. A body the draft refuses is answered here with
 * the draft's refusal; one it takes needs its preview; a pause or silence alone goes through only
 * where the route keeps every other field.
 */
export function previewFirst(handler: Handler, gate: Gate): Handler {
  return async (c, next) => {
    const actor = actorOf(c);
    if (actor?.via !== "token") {
      return handler(c, next);
    }
    const body = await bodyOf(c);
    if (!body) {
      // Not an object: the schema has refused it before this runs.
      return handler(c, next);
    }
    const target = gate.targetOf(c, body);
    if (isHoldOnly(body) && gate.holdKeepsRest(target)) {
      return handler(c, next);
    }
    const draft = gate.draft(body, target);
    if (!draft.ok) {
      return c.json({ error: draft.error, ...(draft.field ? { field: draft.field } : {}) }, draft.status);
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
