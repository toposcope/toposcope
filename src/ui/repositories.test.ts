import { describe, expect, test } from "bun:test";
import { parseRepo } from "../shared/code-links";
import { isFrameLine, rowVersion } from "./code-links";
import { knownFromWords, pickHandService, type ServiceRow } from "./repositories";

const repo = (raw: string, from: "set" | "resource" | "mark") => ({ ...parseRepo(raw)!, from });
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

  test("Set one by hand is for the row picked, else the first with none", () => {
    expect(pickHandService(rows, null)).toBe("billing");
    expect(pickHandService(rows, "worker")).toBe("worker");
    expect(pickHandService(rows, "gone")).toBe("billing");
    expect(pickHandService(rows.slice(0, 3), null)).toBeNull();
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
