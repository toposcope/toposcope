import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = `${import.meta.dir}/../..`;
const secrets = ["CLICKHOUSE_PASSWORD", "TOPOSCOPE_PASSWORD", "TOPOSCOPE_INGEST_TOKEN"];

test("the README quick start writes the three secrets without printing them", async () => {
  const readme = await Bun.file(`${root}/README.md`).text();
  const block = readme.match(/```bash\n(cp env\.example \.env\n[\s\S]*?docker compose up -d\n)```/)?.[1];
  expect(block).toBeDefined();

  // The release zip, with a docker that does nothing.
  const dir = mkdtempSync(join(tmpdir(), "toposcope-quickstart-"));
  try {
    writeFileSync(join(dir, "env.example"), await Bun.file(`${root}/.env.example`).text());
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin/docker"), 0o755);

    const child = Bun.spawn(["bash", "-euc", block!], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(out + err).toBe("");

    const env = readFileSync(join(dir, ".env"), "utf8");
    const values = secrets.map((key) => env.match(new RegExp(`^${key}=([0-9a-f]{64})$`, "m"))?.[1]);
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(new Set(values).size).toBe(secrets.length);
    expect(env).toContain("CLICKHOUSE_USER=default");
    expect(statSync(join(dir, ".env")).mode & 0o077).toBe(0);
    expect(existsSync(join(dir, ".env.bak"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
