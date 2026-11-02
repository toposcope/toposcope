import { describe, expect, test } from "bun:test";
import { githubStatusWords, type GithubState } from "./github";

const base: GithubState = { configured: true, state: "off", install_url: "https://github.com/apps/toposcope/installations/new" };
const on: GithubState = { ...base, state: "on", login: "honzabit", connected_by: { name: "Maya K." }, accounts: ["acme", "honzabit"], repositories: 23 };

describe("the GitHub band's line (42a–42h)", () => {
  test("each state says where it stands", () => {
    expect(githubStatusWords(base, true)).toBe("Not connected");
    expect(githubStatusWords({ ...base, state: "connecting" }, true)).toBe("Connecting");
    expect(githubStatusWords(on, true)).toBe("Connected as honzabit by Maya K. · 23 repositories on acme, honzabit");
    expect(githubStatusWords({ ...on, repositories: 0, accounts: [] }, true)).toBe("Signed in as honzabit · the Toposcope App can see no repositories yet");
    expect(githubStatusWords({ ...base, state: "ended", ended_at: Date.UTC(2026, 10, 2, 14, 20) }, true)).toBe("Access ended on GitHub on 2026-11-02 14:20 UTC · Set lists only repositories used here");
  });

  test("someone who cannot connect sees who did and how many (42g)", () => {
    expect(githubStatusWords(on, false)).toBe("Connected by Maya K. · 23 repositories");
    expect(githubStatusWords({ ...on, repositories: 1 }, false)).toBe("Connected by Maya K. · 1 repository");
  });

  test("an error rides on the line", () => {
    expect(githubStatusWords({ ...base, error: "GitHub was not approved." }, true)).toBe("Not connected · GitHub was not approved.");
  });
});
