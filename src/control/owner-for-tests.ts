import { createPersonToken, createServiceAccount, serviceAccountByName } from "./people";

/**
 * For tests and local scripts that drive an app in their own process (#305): an Owner service
 * account's token, sent as `Authorization: Bearer`. It writes to whatever SQLite the process opened.
 */
export function ownerBearer(name = "tests"): string {
  const account = serviceAccountByName(name) ?? createServiceAccount({ name, role: "owner", created_by: "tests" });
  return `Bearer ${createPersonToken(account.id, { name: "tests", created_by: "tests" }).token}`;
}

/**
 * For tests (#309): takes a session that is waiting on two-step setup through it, with a real
 * code from the secret, as an authenticator app would. `cookie` is `name=value`.
 */
export async function passTwoStepSetup(fetcher: (req: Request) => Response | Promise<Response>, cookie: string, base = "http://app.test"): Promise<string[]> {
  const { sessionAtStage } = await import("./people");
  const { beginSetup, stepOf, totpAt } = await import("./two-step");
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const waiting = sessionAtStage(value);
  if (!waiting) {
    throw new Error("No session is waiting on two-step");
  }
  const secret = beginSetup(waiting.person.id);
  const post = (path: string, body: unknown) =>
    fetcher(new Request(base + path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const set = await post("/api/two-step/setup", { code: totpAt(secret, stepOf(Date.now())) });
  if (!set.ok) {
    throw new Error(`two-step setup refused: ${set.status} ${await set.text()}`);
  }
  const codes = ((await set.json()) as { backup_codes: string[] }).backup_codes;
  const done = await post("/api/two-step/finish", {});
  if (!done.ok) {
    throw new Error(`two-step finish refused: ${done.status}`);
  }
  return codes;
}

/** The six digits an authenticator app shows now for this person, for tests (#309). */
export async function currentCode(personId: string, offsetSteps = 0): Promise<string> {
  const { getDb } = await import("./index");
  const row = getDb().query("SELECT totp_secret FROM people WHERE id = ?").get(personId) as { totp_secret: string };
  const twoStep = await import("./two-step");
  const secret = twoStep.openSecretForTests(row.totp_secret);
  return twoStep.totpAt(secret, twoStep.stepOf(Date.now()) + offsetSteps);
}
