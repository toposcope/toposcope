/**
 * Host commands (#305), run inside the app container by `toposcope.sh`:
 *
 *   bun run src/cli.ts owner-link <email>
 *   bun run src/cli.ts service-token <account> <viewer|operator|owner> [token name]
 *
 * Reaching the host is the proof, as reaching `.env` was. Nothing they print is logged or kept on
 * disk: the link and the token are shown once, here.
 */
import { getDb } from "./control";
import { createOwnerLink, createPersonToken, createServiceAccount, isRole, serviceAccountByName } from "./control/people";

function origin(): string {
  const env = process.env.TOPOSCOPE_PUBLIC_URL?.replace(/\/+$/, "");
  if (env) {
    return env;
  }
  const row = getDb().query("SELECT value FROM settings WHERE key = 'seen_origin'").get() as { value: string } | null;
  return row?.value ?? "http://127.0.0.1:8080";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

if (command === "owner-link") {
  const email = args[0];
  if (!email) {
    fail("Usage: owner-link <email>");
  }
  try {
    const link = createOwnerLink(email);
    const minutes = Math.round((link.expires_at - Date.now()) / 60_000);
    console.log(link.makes ? `Opens once, for ${minutes} minutes, to make the Owner ${email.toLowerCase()}:` : `Opens once, for ${minutes} minutes, to give the Owner ${email.toLowerCase()} a new password; their sessions end:`);
    console.log(`${origin()}/setup/${link.token}`);
    console.log("On another address, open /setup/… there instead.");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
} else if (command === "service-token") {
  const [account, role, tokenName] = args;
  if (!account || !isRole(role)) {
    fail("Usage: service-token <account> <viewer|operator|owner> [token name]");
  }
  try {
    const existing = serviceAccountByName(account);
    if (existing && existing.role !== role) {
      fail(`The service account ${account} is ${existing.role}; change its role in Access, or name another account`);
    }
    const person = existing ?? createServiceAccount({ name: account, role, created_by: "host" });
    const { token } = createPersonToken(person.id, { name: tokenName ?? "host", created_by: "host" });
    console.log(token);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
} else {
  fail("Commands: owner-link <email> · service-token <account> <viewer|operator|owner> [token name]");
}
