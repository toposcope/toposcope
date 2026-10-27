/** Local `bun run dev` may fill these. Packaged boot must not. */
export const DEMO_PASSWORD = "toposcope";
export const DEMO_INGEST_TOKEN = "toposcope-ingest";

const demoPasswords = new Set([DEMO_PASSWORD]);
const demoTokens = new Set([DEMO_INGEST_TOKEN]);

export function allowDemoSecrets(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.TOPOSCOPE_DEV === "1";
}

export function packagedSecretsError(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (allowDemoSecrets(env)) {
    return null;
  }
  const token = env.TOPOSCOPE_INGEST_TOKEN ?? "";
  const clickhouse = env.CLICKHOUSE_PASSWORD ?? "";
  // #308: the ingest token is imported once into Access and may then leave .env; a demo value
  // is still refused while it is there.
  if (token && demoTokens.has(token)) {
    return "TOPOSCOPE_INGEST_TOKEN is the demo value; set a generated secret in .env, or make an ingest token in Access";
  }
  if (!clickhouse || demoPasswords.has(clickhouse)) {
    return "CLICKHOUSE_PASSWORD is missing or is the demo value; set a generated secret in .env";
  }
  return null;
}

export function requirePackagedSecrets(): void {
  const error = packagedSecretsError();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
