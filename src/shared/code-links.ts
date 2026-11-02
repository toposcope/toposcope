import { appRelativePath } from "./app-path";

/**
 * Code links (#393, frames 37g–37i): a service's repository, and the URLs a sha, two deploys or a
 * stack frame open on its git host. Links only: Toposcope never fetches a repository and keeps no
 * token, so every URL here is built from strings it already has.
 */

export type RepoHost = "github" | "gitlab" | "gitea" | "bitbucket";

export const repoHostWords: Record<RepoHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
  bitbucket: "Bitbucket",
};

/** A repository as a link base: `https://github.com/acme/api`, its host's shape, and `acme/api`. */
export type Repo = { url: string; host: RepoHost; name: string };

/** The resource attribute OpenTelemetry names a service's repository with. */
export const repoResourceKey = "vcs.repository.url.full";

/** Longest repository URL a row may set; a longer one is not a repository. */
export const maxRepoUrlLength = 300;

/**
 * Read a repository from what a sender or an Operator wrote: `https://github.com/acme/api`,
 * `github.com/acme/api`, `git@github.com:acme/api.git` or `ssh://git@host/acme/api`. Null for
 * anything that is not an http(s) or ssh repository with an owner and a name, so a link never
 * carries another scheme.
 */
export function parseRepo(raw: string): Repo | null {
  let text = raw.trim();
  if (!text || text.length > maxRepoUrlLength || /\s/.test(text)) {
    return null;
  }
  let scheme = "https";
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(text);
  if (scp) {
    text = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
    if (m) {
      const given = m[1]!.toLowerCase();
      if (given === "http" || given === "https") {
        scheme = given;
      } else if (given !== "ssh" && given !== "git" && given !== "git+ssh") {
        return null;
      }
      text = m[2]!.replace(/^[^@/]*@/, "");
    }
  }
  const slash = text.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const hostPort = text.slice(0, slash).toLowerCase();
  // An ssh port is not the web host's port.
  const host = scheme === "https" && !/^https?:/i.test(raw.trim()) ? hostPort.replace(/:\d+$/, "") : hostPort;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) || !host.includes(".") && !host.startsWith("localhost")) {
    return null;
  }
  const path = text
    .slice(slash + 1)
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/-$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || !/^[\w.~-]+$/.test(p))) {
    return null;
  }
  return { url: `${scheme}://${host}/${parts.join("/")}`, host: repoHostOf(host), name: parts.join("/") };
}

/** The link shape a host speaks; a host Toposcope cannot tell is Gitea / Forgejo, the self-hosted one. */
export function repoHostOf(host: string): RepoHost {
  const h = host.replace(/:\d+$/, "");
  if (h === "github.com" || /(^|\.)github\./.test(h)) {
    return "github";
  }
  if (h === "gitlab.com" || /(^|\.)gitlab\./.test(h)) {
    return "gitlab";
  }
  if (h === "bitbucket.org" || /(^|\.)bitbucket\./.test(h)) {
    return "bitbucket";
  }
  return "gitea";
}

/** The repository without its scheme, as Settings lists it: `github.com/acme/api`. */
export function repoDisplay(repo: Repo): string {
  return repo.url.replace(/^https?:\/\//, "");
}

function encPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The commit page. */
export function commitUrl(repo: Repo, sha: string): string {
  const s = encodeURIComponent(sha);
  switch (repo.host) {
    case "gitlab":
      return `${repo.url}/-/commit/${s}`;
    case "bitbucket":
      return `${repo.url}/commits/${s}`;
    default:
      return `${repo.url}/commit/${s}`;
  }
}

/** What changed from `from` to `to`: the host's compare page. */
export function compareUrl(repo: Repo, from: string, to: string): string {
  const a = encodeURIComponent(from);
  const b = encodeURIComponent(to);
  switch (repo.host) {
    case "gitlab":
      return `${repo.url}/-/compare/${a}...${b}`;
    case "bitbucket":
      return `${repo.url}/branches/compare/${b}%0D${a}#diff`;
    default:
      return `${repo.url}/compare/${a}...${b}`;
  }
}

/**
 * A file at a line. `sha` null is the repository's default branch, which Toposcope does not know
 * by name: GitHub, GitLab and Bitbucket read `HEAD` as it, Gitea / Forgejo's `src/<path>` does.
 */
export function blobUrl(repo: Repo, sha: string | null, path: string, line: number | null): string {
  const p = encPath(path);
  const ref = sha ? encodeURIComponent(sha) : "HEAD";
  switch (repo.host) {
    case "gitlab":
      return `${repo.url}/-/blob/${ref}/${p}${line ? `#L${line}` : ""}`;
    case "bitbucket":
      return `${repo.url}/src/${ref}/${p}${line ? `#lines-${line}` : ""}`;
    case "gitea":
      return `${repo.url}/src/${sha ? `commit/${ref}/` : ""}${p}${line ? `#L${line}` : ""}`;
    default:
      return `${repo.url}/blob/${ref}/${p}${line ? `#L${line}` : ""}`;
  }
}

/** The tree at a sha, or the default branch's when null. */
export function treeUrl(repo: Repo, sha: string | null): string {
  if (!sha) {
    return repo.url;
  }
  const s = encodeURIComponent(sha);
  switch (repo.host) {
    case "gitlab":
      return `${repo.url}/-/tree/${s}`;
    case "bitbucket":
      return `${repo.url}/src/${s}`;
    case "gitea":
      return `${repo.url}/src/commit/${s}`;
    default:
      return `${repo.url}/tree/${s}`;
  }
}

/** A stack line cut into text and the file locations an app frame links: `(/app/src/a.js:41)`. */
export type StackPiece = { text: string; path?: string; line?: number | null };

// A path, then `:41`, `:41:12`, PHP's `(41)` or Python's `", line 41`.
const location = /(?:file:\/\/)?((?:[a-zA-Z]:)?[\\/][^\s()'"<>:,]*[^\s()'"<>:.,])(?::(\d+)(?::\d+)?|\((\d+)\)|(", line (\d+)))?/g;

/**
 * Cut a stack into text and file locations. A location under the app's own paths (the roots `e1`
 * strips) carries `path`, relative to the repository, and its line; a library's
 * (`node_modules`, `site-packages`, `vendor`, …) or any other stays text.
 */
export function stackPieces(stack: string): StackPiece[] {
  const pieces: StackPiece[] = [];
  let at = 0;
  for (const m of stack.matchAll(location)) {
    const file = m[1]!;
    const rel = appRelativePath(file);
    if (!rel || isLibraryPath(file)) {
      continue;
    }
    const start = m.index!;
    // Python's `", line 41` stays outside the link: the link is the path and its numbers.
    const text = m[4] ? m[0].slice(0, m[0].length - m[4].length) : m[0];
    const line = m[2] ?? m[3] ?? m[5];
    if (start > at) {
      pieces.push({ text: stack.slice(at, start) });
    }
    pieces.push({ text, path: rel, line: line ? Number(line) : null });
    at = start + text.length;
  }
  if (at < stack.length) {
    pieces.push({ text: stack.slice(at) });
  }
  return pieces;
}

/** A library's file, never the app's own, wherever it is installed. */
export function isLibraryPath(file: string): boolean {
  return /(^|[\\/])(node_modules|site-packages|dist-packages|vendor|gems|\.cargo|go[\\/]pkg[\\/]mod|lib[\\/]python[\d.]*)([\\/]|$)/i.test(
    file,
  );
}
