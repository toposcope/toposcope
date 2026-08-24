import { describe, expect, test } from "bun:test";
import { ghcrAppPin } from "../../scripts/check-release-pin";

const root = `${import.meta.dir}/../..`;

describe("packaged compose", () => {
  test("pins a versioned image and has no demo secrets", async () => {
    const yaml = await Bun.file(`${root}/compose.yml`).text();
    const version = (
      (await Bun.file(`${root}/package.json`).json()) as { version: string }
    ).version;
    expect(ghcrAppPin(yaml)).toBe(version);
    expect(yaml).toContain(`image: ghcr.io/toposcope/toposcope:${version}`);
    expect(yaml).not.toContain("build: .");
    expect(yaml).not.toContain("toposcope-ingest");
    expect(yaml).not.toMatch(/TOPOSCOPE_PASSWORD: toposcope\b/);
    expect(yaml).not.toContain("8123:8123");
    expect(yaml).toContain("127.0.0.1:8080:8080");
    expect(yaml).toContain("TOPOSCOPE_PASSWORD: ${TOPOSCOPE_PASSWORD:?");
    expect(yaml).toContain("memory: 4G");
  });
});

describe("dev compose", () => {
  test("publishes ClickHouse for bun run dev", async () => {
    const yaml = await Bun.file(`${root}/compose.dev.yml`).text();
    expect(yaml).toContain("127.0.0.1:8123:8123");
    expect(yaml).toContain("memory: 14G");
    expect(yaml).toContain("clickhouse/init.sql");
    expect(yaml).not.toContain("ghcr.io/toposcope/toposcope");
  });
});

describe("env example", () => {
  test("is placeholders, not demo values", async () => {
    const env = await Bun.file(`${root}/.env.example`).text();
    expect(env).toContain("TOPOSCOPE_PASSWORD=");
    expect(env).toContain("TOPOSCOPE_INGEST_TOKEN=");
    expect(env).not.toContain("TOPOSCOPE_PASSWORD=toposcope");
    expect(env).not.toContain("TOPOSCOPE_INGEST_TOKEN=toposcope-ingest");
    expect(env).not.toContain("CLICKHOUSE_PASSWORD=toposcope");
  });
});

describe("release workflow", () => {
  test("gates publication on ClickHouse-backed tests and typechecking", async () => {
    const yml = await Bun.file(`${root}/.github/workflows/release-image.yml`).text();
    expect(yml).toContain("image: clickhouse/clickhouse-server:26.3");
    expect(yml).toContain("CLICKHOUSE_USER: default");
    expect(yml).toContain("CLICKHOUSE_PASSWORD: toposcope");
    expect(yml).toContain("- 8123:8123");
    expect(yml).toContain("SELECT 1");
    expect(yml).toContain("images: ghcr.io/toposcope/toposcope");

    const pin = yml.indexOf("Check version pin");
    const install = yml.indexOf("bun install --frozen-lockfile");
    const tests = yml.indexOf("bun test");
    const typecheck = yml.indexOf("bun run typecheck");
    const notes = yml.indexOf("Changelog release notes");
    const login = yml.indexOf("docker/login-action");
    const push = yml.indexOf("docker/build-push-action");
    const release = yml.indexOf("softprops/action-gh-release");
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(install);
    expect(install).toBeLessThan(tests);
    expect(tests).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(notes);
    expect(notes).toBeLessThan(login);
    expect(typecheck).toBeLessThan(push);
    expect(notes).toBeLessThan(release);
  });

  test("attaches env.example so GitHub does not rename a leading-dot file", async () => {
    const yml = await Bun.file(`${root}/.github/workflows/release-image.yml`).text();
    expect(yml).toContain("cp .env.example env.example");
    expect(yml).toContain("\n            env.example\n");
    expect(yml).not.toMatch(/^\s+\.env\.example\s*$/m);
  });

  test("attaches LICENSE with the stranger zip", async () => {
    const yml = await Bun.file(`${root}/.github/workflows/release-image.yml`).text();
    expect(yml).toContain("\n            LICENSE\n");
  });

  test("uses the CHANGELOG section as GitHub release notes", async () => {
    const yml = await Bun.file(`${root}/.github/workflows/release-image.yml`).text();
    expect(yml).toContain("scripts/changelog-release-notes.ts");
    expect(yml).toContain("body_path: release-notes.md");
  });
});

describe("pull request workflow", () => {
  test("runs ClickHouse-backed tests and typechecking without dev compose", async () => {
    const yml = await Bun.file(`${root}/.github/workflows/pull-request.yml`).text();
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("image: clickhouse/clickhouse-server:26.3");
    expect(yml).toContain("CLICKHOUSE_USER: default");
    expect(yml).toContain("CLICKHOUSE_PASSWORD: toposcope");
    expect(yml).toContain("- 8123:8123");
    expect(yml).toContain("SELECT 1");
    expect(yml).not.toContain("compose.dev.yml");

    const install = yml.indexOf("bun install --frozen-lockfile");
    const tests = yml.indexOf("bun test");
    const typecheck = yml.indexOf("bun run typecheck");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(tests);
    expect(tests).toBeLessThan(typecheck);
  });
});

describe("LICENSE", () => {
  test("is MIT Expat under Vertixer Ltd. with an ee/ reservation", async () => {
    const text = await Bun.file(`${root}/LICENSE`).text();
    expect(text).toContain("Copyright (c) 2026 Vertixer Ltd.");
    expect(text).toContain("Toposcope Software");
    expect(text).toContain('"ee/"');
    expect(text).toContain("MIT Expat");
    expect(text).toContain("Permission is hereby granted");
    expect(text).not.toContain("PostHog");
  });
});

describe("ee/", () => {
  test("is a LICENSE stub and the MIT app does not import it", async () => {
    const names = (
      await Array.fromAsync(new Bun.Glob("*").scan({ cwd: `${root}/ee` }))
    ).sort();
    expect(names).toEqual(["LICENSE"]);
    const license = await Bun.file(`${root}/ee/LICENSE`).text();
    expect(license).toContain("Copyright (c) 2026 Vertixer Ltd.");
    expect(license).toContain("All rights reserved.");
    expect(license).not.toContain("Permission is hereby granted");

    const dockerfile = await Bun.file(`${root}/Dockerfile`).text();
    expect(dockerfile).toContain("COPY --from=build /app/src ./src");
    expect(dockerfile).not.toMatch(/COPY[^\n]*ee/);

    const imported: string[] = [];
    for (const rel of [
      ...(await Array.fromAsync(
        new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root }),
      )),
      ...(await Array.fromAsync(
        new Bun.Glob("scripts/**/*.ts").scan({ cwd: root }),
      )),
    ]) {
      const text = await Bun.file(`${root}/${rel}`).text();
      for (const line of text.split("\n")) {
        const spec =
          line.match(/\bfrom\s+['"]([^'"]+)['"]/)?.[1] ??
          line.match(/\bimport\s*\(\s*['"]([^'"]+)['"]/)?.[1];
        if (!spec) {
          continue;
        }
        if (spec === "ee" || spec.startsWith("ee/") || spec.split("/").includes("ee")) {
          imported.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(imported).toEqual([]);
  });
});

describe("vector example", () => {
  test("posts OTLP protobuf to /v1/logs with the env token", async () => {
    const yaml = await Bun.file(`${root}/vector.yaml`).text();
    expect(yaml).toContain("uri: http://127.0.0.1:8080/v1/logs");
    expect(yaml).toContain("codec: otlp");
    expect(yaml).toContain("request:");
    expect(yaml).toContain('Authorization: "Bearer ${TOPOSCOPE_INGEST_TOKEN}"');
    expect(yaml).not.toContain("uri: http://127.0.0.1:8080/v1/logs\n      headers:");
    expect(yaml).toContain('"service.name"');
    expect(yaml).toContain("smoke");
    expect(yaml).not.toContain("toposcope-ingest");
  });
});
