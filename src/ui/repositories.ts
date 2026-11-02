import { repoResourceKey, type Repo } from "../shared/code-links";

/** One row of `GET /api/repositories` (#393, frame 37i). */
export type ServiceRow = {
  service: string;
  repository: (Repo & { from: "set" | "resource" | "mark" }) | null;
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

/** The service the Set one by hand row is for: the one picked, else the first with none. */
export function pickHandService(rows: ServiceRow[], current: string | null): string | null {
  if (current && rows.some((r) => r.service === current)) {
    return current;
  }
  return rows.find((r) => !r.repository)?.service ?? null;
}
