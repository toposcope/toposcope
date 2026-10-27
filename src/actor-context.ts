import type { Context } from "hono";
import type { Actor } from "./control/people";

/** The person (or service account) a request acts as, set by the auth middleware (#305). */
export function actorOf(c: Context): Actor | null {
  return ((c.get as (key: string) => unknown)("actor") as Actor | undefined) ?? null;
}

export function setActor(c: Context, actor: Actor): void {
  (c.set as (key: string, value: unknown) => void)("actor", actor);
}
