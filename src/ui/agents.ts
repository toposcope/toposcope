/**
 * Agents in the app (#357, frames 34a–34c): what Let someone in › Agent says an agent may and may
 * never do, the MCP setup shown once on Make, and the words for what an agent saved.
 */

/** Who an agent may be: a Viewer or an Operator, never an Owner (34a). */
export type AgentRole = "operator" | "viewer";

export const agentRoleCards: Array<{ role: AgentRole; name: string; words: string }> = [
  { role: "operator", name: "Operator", words: "Reads everything, and makes and changes monitors, saved hunts, Home panels, Fields roles and notes." },
  { role: "viewer", name: "Viewer", words: "Reads everything and saves hunts of its own. Changes nothing anyone else sees." },
];

/** 34a's two lists, from the roles table in docs/people.md. */
export const agentMay: Record<AgentRole, string[]> = {
  operator: ["search, trace, compare around a deploy", "make monitors, after a preview", "add panels to Home, set Fields roles", "write notes on the clock"],
  viewer: ["search, trace, compare around a deploy", "save hunts of its own", "export rows"],
};
export const agentNever: Record<AgentRole, string[]> = {
  operator: ["invite people or change roles", "make tokens, links or shares", "change retention or sign-in", "be made an Owner"],
  viewer: ["make or change monitors, notes or Fields", "invite people, make tokens, links or shares", "change retention or sign-in", "be made an Owner"],
};

/** The name after `agent: `, as `toposcope.sh agent <name>` takes it. */
export function agentNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "A name, such as claude";
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/.test(trimmed) ? null : "Letters, digits, . _ or -, starting with a letter or digit";
}

export type SetupTab = "claude" | "any" | "host";

/** 34b: how each client connects, with the token in it; `masked` hides it for the screen, not the copy. */
export function mcpSetup(tab: SetupTab, input: { origin: string; token: string; name: string }, masked = false): string {
  const token = masked ? "•".repeat(24) : input.token;
  const url = `${input.origin.replace(/\/+$/, "")}/mcp`;
  if (tab === "claude") {
    return `claude mcp add --transport http toposcope ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  }
  if (tab === "any") {
    return JSON.stringify({ mcpServers: { toposcope: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  return `./toposcope.sh agent ${input.name}`;
}

export const setupWhere: Record<SetupTab, string> = {
  claude: "In the app's repository",
  any: "In the client's MCP settings",
  host: "Beside compose.yml, where Toposcope runs: a new token in a file only you can read, never printed",
};

/** 34c: "saved 2 monitors, 2 Home panels", or "saved nothing yet". */
export function agentSavedWords(saved: { monitors: number; home_panels: number; hunts: number } | undefined): string {
  if (!saved) {
    return "saved nothing yet";
  }
  const parts = [
    [saved.monitors, "monitor"],
    [saved.home_panels, "Home panel"],
    [saved.hunts, "saved hunt"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  return parts.length ? `saved ${parts.join(", ")}` : "saved nothing yet";
}

/** 34c's Watch heading: "2 saved by agent: claude", or "3 saved by agents" when more than one did. */
export function agentWatchWords(monitors: ReadonlyArray<{ made_by?: { name: string; agent?: boolean } | null }>): { count: number; by: string } | null {
  const names = monitors.filter((m) => m.made_by?.agent).map((m) => m.made_by!.name);
  if (names.length === 0) {
    return null;
  }
  return { count: names.length, by: new Set(names).size === 1 ? names[0]! : "agents" };
}
