export function defaultSqlitePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SQLITE_PATH ?? "./data/toposcope.sqlite";
}
