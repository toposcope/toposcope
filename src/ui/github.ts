/** What `GET /api/github` answers (#416, frames 42a–42h). */
export type GithubState = {
  configured: boolean;
  state: "off" | "connecting" | "on" | "ended";
  install_url: string;
  login?: string;
  connected_by?: { name: string } | null;
  connected_at?: number;
  ended_at?: number;
  code?: { user_code: string; verification_uri: string; expires_at: number };
  accounts?: string[];
  repositories?: number;
  error?: string;
};

/** One row of `GET /api/github/repositories`. */
export type GithubRepo = { url: string; name: string; owner: string; private: boolean };

function utc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * The band's line: "Not connected", "Connected as honzabit by Maya K. · 23 repositories on acme,
 * honzabit" (an Owner, 42d), "Connected by Maya K. · 23 repositories" (everyone else, 42g).
 */
export function githubStatusWords(g: GithubState, canConnect: boolean): string {
  const by = g.connected_by?.name ?? "an Owner";
  const n = g.repositories ?? 0;
  const repos = `${n} ${n === 1 ? "repository" : "repositories"}`;
  let words: string;
  switch (g.state) {
    case "connecting":
      words = "Connecting";
      break;
    case "ended":
      words = `Access ended on GitHub${g.ended_at ? ` on ${utc(g.ended_at)}` : ""} · Set lists only repositories used here`;
      break;
    case "on":
      if (g.repositories === undefined) {
        words = `Connected as ${g.login} by ${by}`;
      } else if (n === 0) {
        words = `Signed in as ${g.login} · the Toposcope App can see no repositories yet`;
      } else if (!canConnect) {
        words = `Connected by ${by} · ${repos}`;
      } else {
        words = `Connected as ${g.login} by ${by} · ${repos}${g.accounts?.length ? ` on ${g.accounts.join(", ")}` : ""}`;
      }
      break;
    default:
      words = "Not connected";
  }
  return g.error ? `${words} · ${g.error}` : words;
}
