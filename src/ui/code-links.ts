import { useEffect, useState } from "react";
import type { Repo } from "../shared/code-links";

/** What `GET /api/code` answers (#393): a repository, a deploy mark, and the deploy before it. */
export type CodeMark = { id: string; ts: string; title: string; version: string; sha: string | null };
export type CodeAnswer = { repository: (Repo & { from: "set" | "resource" | "mark" }) | null; mark: CodeMark | null; previous: CodeMark | null };

/** `/api/code?…` for these params, or null while it reads or when `query` is null. */
export function useCode(query: string | null): CodeAnswer | null {
  const [answer, setAnswer] = useState<CodeAnswer | null>(null);
  useEffect(() => {
    setAnswer(null);
    if (!query) {
      return;
    }
    const ac = new AbortController();
    void fetch(`/api/code?${query}`, { signal: ac.signal })
      .then((res) => (res.ok ? (res.json() as Promise<CodeAnswer>) : null))
      .then(setAnswer)
      .catch(() => undefined);
    return () => ac.abort();
  }, [query]);
  return answer;
}

/** The first six characters, as the marks panel names a sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 6);
}

/** What a deploy is called in a sentence: its version, else its title. */
export function deployName(mark: CodeMark): string {
  return mark.version || mark.title;
}

/** The row's release, as ingest stores the resource's `service.version`. */
export function rowVersion(attrs: Record<string, unknown> | undefined): string | null {
  const v = attrs?.version ?? attrs?.["service.version"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A stack line that names a frame: `at …`, Python's `File "…"`, PHP's `#0 …`, Go's tab-indented file. */
export function isFrameLine(line: string): boolean {
  return /^\s+(at\s|File\s"|\/|[a-zA-Z]:\\)|^#\d+\s/.test(line);
}
