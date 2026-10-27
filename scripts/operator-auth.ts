import { envValue } from "../src/shared/env";

/**
 * How a local script acts on an instance (#305): `Authorization: Bearer` with `TOPOSCOPE_TOKEN`
 * (a personal or service account token from Access), or, when the script shares the app's SQLite
 * (`SQLITE_PATH`, as e2e does), an Owner service account it makes there. There is no Basic.
 */
let cached: string | undefined;
export async function operatorAuth(account = "scripts"): Promise<string> {
  if (cached) {
    return cached;
  }
  const token = envValue("TOPOSCOPE_TOKEN");
  if (token) {
    cached = `Bearer ${token}`;
    return cached;
  }
  if (!process.env.SQLITE_PATH) {
    throw new Error("Set TOPOSCOPE_TOKEN to a personal or service account token, or SQLITE_PATH to the app's SQLite file");
  }
  const { ownerBearer } = await import("../src/control/owner-for-tests");
  cached = ownerBearer(account);
  return cached;
}
