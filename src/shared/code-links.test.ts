import { describe, expect, test } from "bun:test";
import { appRelativePath } from "./app-path";
import { blobUrl, commitUrl, compareUrl, isLibraryPath, parseRepo, repoDisplay, stackPieces, treeUrl } from "./code-links";

describe("parseRepo (#393)", () => {
  test("reads the forms a sender or an Operator writes", () => {
    for (const raw of ["https://github.com/acme/api", "github.com/acme/api", "git@github.com:acme/api.git", "ssh://git@github.com/acme/api.git", "https://github.com/acme/api/"]) {
      expect(parseRepo(raw)).toEqual({ url: "https://github.com/acme/api", host: "github", name: "acme/api" });
    }
  });

  test("keeps a GitLab subgroup and an explicit http", () => {
    expect(parseRepo("https://gitlab.com/acme/shop/web")).toEqual({ url: "https://gitlab.com/acme/shop/web", host: "gitlab", name: "acme/shop/web" });
    expect(parseRepo("http://git.lan:3000/ops/worker")?.url).toBe("http://git.lan:3000/ops/worker");
  });

  test("tells the host's shape; an unknown host is Gitea / Forgejo", () => {
    expect(parseRepo("bitbucket.org/acme/api")?.host).toBe("bitbucket");
    expect(parseRepo("gitlab.acme.dev/acme/api")?.host).toBe("gitlab");
    expect(parseRepo("https://git.acme.dev/ops/worker")?.host).toBe("gitea");
    expect(parseRepo("codeberg.org/acme/api")?.host).toBe("gitea");
  });

  test("refuses what is not a repository, and any other scheme", () => {
    for (const raw of ["", "acme/api", "https://github.com/acme", "javascript:alert(1)//github.com/a/b", "data:text/html,x/y", "https://github.com/acme/../x", "https://exa mple.com/a/b", "ftp://host.com/a/b"]) {
      expect(parseRepo(raw)).toBeNull();
    }
  });

  test("Settings shows it without the scheme", () => {
    expect(repoDisplay(parseRepo("https://github.com/acme/api")!)).toBe("github.com/acme/api");
  });
});

describe("link shapes by host", () => {
  const gh = parseRepo("github.com/acme/api")!;
  const gl = parseRepo("gitlab.com/acme/shop")!;
  const gt = parseRepo("git.acme.dev/ops/worker")!;
  const bb = parseRepo("bitbucket.org/acme/api")!;

  test("commit", () => {
    expect(commitUrl(gh, "4f9c1e")).toBe("https://github.com/acme/api/commit/4f9c1e");
    expect(commitUrl(gl, "4f9c1e")).toBe("https://gitlab.com/acme/shop/-/commit/4f9c1e");
    expect(commitUrl(gt, "4f9c1e")).toBe("https://git.acme.dev/ops/worker/commit/4f9c1e");
    expect(commitUrl(bb, "4f9c1e")).toBe("https://bitbucket.org/acme/api/commits/4f9c1e");
  });

  test("compare, from the previous deploy to this one", () => {
    expect(compareUrl(gh, "9e21aa", "4f9c1e")).toBe("https://github.com/acme/api/compare/9e21aa...4f9c1e");
    expect(compareUrl(gl, "9e21aa", "4f9c1e")).toBe("https://gitlab.com/acme/shop/-/compare/9e21aa...4f9c1e");
    expect(compareUrl(gt, "9e21aa", "4f9c1e")).toBe("https://git.acme.dev/ops/worker/compare/9e21aa...4f9c1e");
    expect(compareUrl(bb, "9e21aa", "4f9c1e")).toBe("https://bitbucket.org/acme/api/branches/compare/4f9c1e%0D9e21aa#diff");
  });

  test("a file at a line, at a sha or on the default branch", () => {
    expect(blobUrl(gh, "4f9c1e", "src/billing/charge.js", 41)).toBe("https://github.com/acme/api/blob/4f9c1e/src/billing/charge.js#L41");
    expect(blobUrl(gh, null, "src/a.js", 3)).toBe("https://github.com/acme/api/blob/HEAD/src/a.js#L3");
    expect(blobUrl(gl, "4f9c1e", "src/a.js", 3)).toBe("https://gitlab.com/acme/shop/-/blob/4f9c1e/src/a.js#L3");
    expect(blobUrl(gt, "4f9c1e", "src/a.js", 3)).toBe("https://git.acme.dev/ops/worker/src/commit/4f9c1e/src/a.js#L3");
    expect(blobUrl(gt, null, "src/a.js", 3)).toBe("https://git.acme.dev/ops/worker/src/src/a.js#L3");
    expect(blobUrl(bb, "4f9c1e", "src/a.js", 3)).toBe("https://bitbucket.org/acme/api/src/4f9c1e/src/a.js#lines-3");
    expect(blobUrl(gh, "4f9c1e", "src/a b.js", null)).toBe("https://github.com/acme/api/blob/4f9c1e/src/a%20b.js");
  });

  test("tree", () => {
    expect(treeUrl(gh, "4f9c1e")).toBe("https://github.com/acme/api/tree/4f9c1e");
    expect(treeUrl(gl, "4f9c1e")).toBe("https://gitlab.com/acme/shop/-/tree/4f9c1e");
    expect(treeUrl(gh, null)).toBe("https://github.com/acme/api");
  });
});

describe("stack frames under the app's own paths", () => {
  test("the roots e1 strips are the repository's root", () => {
    expect(appRelativePath("/app/src/billing/charge.js:41:12")).toBe("src/billing/charge.js");
    expect(appRelativePath("/usr/src/app/lib/x.rb")).toBe("lib/x.rb");
    expect(appRelativePath("file:///app/main.go")).toBe("main.go");
    expect(appRelativePath("/var/www/releases/20240101120000/app/Http/Kernel.php")).toBe("app/Http/Kernel.php");
    expect(appRelativePath("/opt/lib/x.js")).toBeNull();
  });

  test("a Node stack: app frames link, library frames stay text", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'amount')",
      "    at chargeCard (/app/src/billing/charge.js:41)",
      "    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
      "    at authorize (/app/src/api/auth.js:23:7)",
    ].join("\n");
    const links = stackPieces(stack).filter((p) => p.path);
    expect(links).toEqual([
      { text: "/app/src/billing/charge.js:41", path: "src/billing/charge.js", line: 41 },
      { text: "/app/src/api/auth.js:23:7", path: "src/api/auth.js", line: 23 },
    ]);
    expect(stackPieces(stack).map((p) => p.text).join("")).toBe(stack);
  });

  test("Python, PHP and Go frames", () => {
    const py = stackPieces('  File "/app/svc/handler.py", line 88, in run').find((p) => p.path);
    expect(py).toEqual({ text: "/app/svc/handler.py", path: "svc/handler.py", line: 88 });
    const php = stackPieces("#0 /var/www/html/index.php(15): run()").find((p) => p.path);
    expect(php).toEqual({ text: "/var/www/html/index.php(15)", path: "html/index.php", line: 15 });
    const go = stackPieces("\t/app/internal/pay/pay.go:41 +0x1d").find((p) => p.path);
    expect(go).toEqual({ text: "/app/internal/pay/pay.go:41", path: "internal/pay/pay.go", line: 41 });
  });

  test("a library's file is never the app's", () => {
    expect(isLibraryPath("/app/node_modules/express/lib/router/layer.js")).toBe(true);
    expect(isLibraryPath("/usr/src/app/vendor/laravel/x.php")).toBe(true);
    expect(isLibraryPath("/home/app/.venv/lib/python3.12/site-packages/flask/app.py")).toBe(true);
    expect(isLibraryPath("/app/src/api/auth.js")).toBe(false);
    expect(stackPieces("    at /usr/local/lib/node/x.js:1:1").some((p) => p.path)).toBe(false);
  });
});
