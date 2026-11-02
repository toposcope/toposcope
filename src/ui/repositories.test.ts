import { describe, expect, test } from "bun:test";
import { parseRepo } from "../shared/code-links";
import { isFrameLine, rowVersion } from "./code-links";
import { knownFromWords, knownRepos, servicesWords, type ServiceRow } from "./repositories";

const repo = (raw: string, from: "set" | "resource" | "mark") => ({ ...parseRepo(raw)!, from, path: null });
const rows: ServiceRow[] = [
  { service: "api", repository: repo("github.com/acme/api", "resource"), mark: null, set_by: null, set_at: null },
  { service: "auth", repository: repo("github.com/acme/auth", "mark"), mark: { id: "d", version: "2.3.0" }, set_by: null, set_at: null },
  { service: "checkout", repository: repo("gitlab.com/acme/shop", "set"), mark: null, set_by: { name: "Maya K." }, set_at: 1 },
  { service: "billing", repository: null, mark: null, set_by: null, set_at: null },
  { service: "worker", repository: null, mark: null, set_by: null, set_at: null },
];

describe("Settings › Repositories (37i)", () => {
  test("Known from says where each repository came from", () => {
    expect(rows.map(knownFromWords)).toEqual([
      "resource · vcs.repository.url.full",
      "deploy mark ▲ 2.3.0 · repo",
      "set here by Maya K.",
      "no deploy mark, nothing on the resource",
      "no deploy mark, nothing on the resource",
    ]);
  });

  test("Set lists each known repository once, the most used first (41b)", () => {
    const shared: ServiceRow[] = [...rows, { service: "support", repository: repo("https://gitlab.com/acme/shop", "resource"), mark: null, set_by: null, set_at: null }];
    expect(knownRepos(shared).map((k) => [k.repo.name, k.services])).toEqual([
      ["acme/shop", ["checkout", "support"]],
      ["acme/api", ["api"]],
      ["acme/auth", ["auth"]],
    ]);
    expect(knownRepos(shared)[0]!.repo).toEqual({ url: "https://gitlab.com/acme/shop", host: "gitlab", name: "acme/shop" });
    expect(knownRepos(rows.slice(3))).toEqual([]);
  });

  test("the services a menu is for, cut after three", () => {
    expect(servicesWords(["billing"])).toBe("billing");
    expect(servicesWords(["billing", "accounting", "support"])).toBe("billing, accounting, support");
    expect(servicesWords(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
  });
});

describe("the Stack tab's code links (37h)", () => {
  test("a row's version is its version, else the resource's service.version", () => {
    expect(rowVersion({ version: "1.4.2" })).toBe("1.4.2");
    expect(rowVersion({ "service.version": "1.4.2" })).toBe("1.4.2");
    expect(rowVersion({})).toBeNull();
  });

  test("frame lines are dimmed when they do not link", () => {
    expect(isFrameLine("    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)")).toBe(true);
    expect(isFrameLine('  File "/usr/lib/python3.12/x.py", line 3')).toBe(true);
    expect(isFrameLine("#1 {main}")).toBe(true);
    expect(isFrameLine("TypeError: Cannot read properties of undefined")).toBe(false);
  });
});
