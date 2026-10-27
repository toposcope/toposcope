import { createPersonToken, createServiceAccount, serviceAccountByName } from "./people";

/**
 * For tests and local scripts that drive an app in their own process (#305): an Owner service
 * account's token, sent as `Authorization: Bearer`. It writes to whatever SQLite the process opened.
 */
export function ownerBearer(name = "tests"): string {
  const account = serviceAccountByName(name) ?? createServiceAccount({ name, role: "owner", created_by: "tests" });
  return `Bearer ${createPersonToken(account.id, { name: "tests", created_by: "tests" }).token}`;
}
