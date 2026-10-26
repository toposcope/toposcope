import { beforeAll, describe, expect, test } from "bun:test";
import { drainAccessUse, noteAccessRefused, noteAccessUsed, resetAccessUse } from "./use";

describe("one use-row shape for every way in (#265)", () => {
  test("a minute's use is one used row per way in; each refusal is its own row", () => {
    resetAccessUse();
    noteAccessUsed("token", "boxes");
    noteAccessUsed("token", "boxes");
    noteAccessUsed("link", "ci-box");
    noteAccessRefused("token", "unknown", "a token that matches none", "/v1/logs");
    const rows = drainAccessUse(Date.parse("2026-10-26T13:00:00Z"));
    expect(rows.map((r) => r.attrs)).toEqual([
      { access: "unknown", kind: "token", status: "refused", reason: "a token that matches none", path: "/v1/logs" },
      { access: "boxes", kind: "token", status: "used", n: 2 },
      { access: "ci-box", kind: "link", status: "used", n: 1 },
    ]);
    expect(rows.every((r) => r.service === "toposcope")).toBe(true);
    expect(drainAccessUse()).toEqual([]);
  });
});

let listed: { rows: Array<{ kind: string; verb: string; name: string; revoke: string | null; today: { used: number } }> };
let bearer: { created: boolean };

beforeAll(() => {
  // A child process keeps this SQLite and these secrets out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { checkBearer } = await import(root + "/auth.ts");
    const { getDb } = await import(root + "/control/index.ts");
    const { hashToken } = await import(root + "/control/tokens.ts");
    const { accessRows } = await import(root + "/access/list.ts");
    getDb().query("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run("t1", "collector", hashToken("created-token-value"), 1);
    const created = checkBearer("Bearer created-token-value");
    checkBearer("Bearer regression-ingest-token");
    const listed = await accessRows();
    console.log(JSON.stringify({ listed, bearer: { created } }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, SQLITE_PATH: ":memory:", TOPOSCOPE_INGEST_TOKEN: "regression-ingest-token", CLICKHOUSE_URL: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  ({ listed, bearer } = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!));
});

describe("GET /api/access (#265)", () => {
  test("the .env token and a created token are rows that write in; use is counted by name", () => {
    expect(bearer.created).toBe(true);
    const env = listed.rows.find((r) => r.name === "TOPOSCOPE_INGEST_TOKEN")!;
    const made = listed.rows.find((r) => r.name === "collector")!;
    expect(env.verb).toBe("token");
    expect(env.revoke).toBeNull();
    expect(made.revoke).toBe("/api/api-tokens/t1");
    // The minute not yet written counts: ClickHouse is unreachable here, so pending use is all there is.
    expect(made.today.used).toBe(1);
    expect(env.today.used).toBe(1);
  });
});
