import { repoResourceKey, type Repo } from "../shared/code-links";

/** One row of `GET /api/repositories` (#393, frame 37i). */
export type ServiceRow = {
  service: string;
  repository: (Repo & { from: "set" | "resource" | "mark"; path: string | null }) | null;
  mark: { id: string; version: string } | null;
  set_by: { name: string } | null;
  set_at: number | null;
};

/** The Known from column: "resource · vcs.repository.url.full", "deploy mark ▲ 2.3.0 · repo", "set here by Maya K.". */
export function knownFromWords(row: ServiceRow): string {
  switch (row.repository?.from) {
    case "set":
      return `set here by ${row.set_by?.name ?? "an Operator"}`;
    case "resource":
      return `resource · ${repoResourceKey}`;
    case "mark":
      return `deploy mark ▲ ${row.mark?.version || "?"} · repo`;
    default:
      return "no deploy mark, nothing on the resource";
  }
}

/** A repository Toposcope already knows, and the services that use it (#413, 41b). */
export type KnownRepo = { repo: Repo; services: string[] };

/** The Set menu's list: every repository on a row, the most used first, then by name. */
export function knownRepos(rows: ServiceRow[]): KnownRepo[] {
  const byUrl = new Map<string, KnownRepo>();
  for (const row of rows) {
    if (!row.repository) {
      continue;
    }
    const { url, host, name } = row.repository;
    const known = byUrl.get(url) ?? { repo: { url, host, name }, services: [] };
    known.services.push(row.service);
    byUrl.set(url, known);
  }
  return [...byUrl.values()].sort((a, b) => b.services.length - a.services.length || a.repo.name.localeCompare(b.repo.name));
}

/** "support", "billing, support", "api, auth, billing +2". */
export function servicesWords(services: string[], max = 3): string {
  return services.length > max ? `${services.slice(0, max).join(", ")} +${services.length - max}` : services.join(", ");
}
