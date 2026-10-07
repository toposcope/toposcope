import { beforeAll, describe, expect, test } from "bun:test";

let results: Record<string, boolean>;

beforeAll(() => {
  // A child process keeps this SQLite and these secrets out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)};
    const { checkBearer } = await import(root + "/auth.ts");
    const { getDb } = await import(root + "/control/index.ts");
    const { hashToken } = await import(root + "/control/tokens.ts");
    const out = {};
    out.unknown = checkBearer("Bearer not-a-token");
    out.oneChar = checkBearer("Bearer x");
    out.configured = checkBearer("Bearer regression-ingest-token");
    out.configuredPrefix = checkBearer("Bearer regression-ingest");
    getDb()
      .query("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("t1", "collector", hashToken("created-token-value"), 1);
    out.created = checkBearer("Bearer created-token-value");
    out.unknownBesideCreated = checkBearer("Bearer still-not-a-token");
    getDb().query("DELETE FROM api_tokens WHERE id = ?").run("t1");
    out.deleted = checkBearer("Bearer created-token-value");
    console.log(JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      SQLITE_PATH: ":memory:",
      TOPOSCOPE_INGEST_TOKEN: "regression-ingest-token",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  results = JSON.parse(child.stdout.toString()) as Record<string, boolean>;
});

describe("ingest bearer token", () => {
  test("a token that was never issued is refused", () => {
    expect(results.unknown).toBe(false);
    expect(results.oneChar).toBe(false);
    expect(results.configuredPrefix).toBe(false);
    expect(results.unknownBesideCreated).toBe(false);
  });

  test("a deleted token is refused", () => {
    expect(results.deleted).toBe(false);
  });

  test("the configured ingest token and a created token are accepted", () => {
    expect(results.configured).toBe(true);
    expect(results.created).toBe(true);
  });
});
