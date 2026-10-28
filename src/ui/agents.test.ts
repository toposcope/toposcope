import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentNameProblem, agentSavedWords, agentWatchWords, mcpSetup } from "./agents";
import { LetSomeoneIn } from "./components/access-view";
import { AgentBadge } from "./components/agent-badge";
import { AgentMade } from "./components/agent-step";
import { AgentsGroup, agentMadeWords, tokenKind, type PersonRow } from "./components/people-groups";
import { PlaceTags } from "./components/watch-view";

/** Agents in the app (#357, frames 34a–34c). */
const noop = () => undefined;
const token = "tsp1_agent-token-for-the-test";
const now = Date.parse("2026-10-28T13:26:00Z");

describe("Let someone in › Agent (34a)", () => {
  test("is the fourth door, between Token and Link", () => {
    const html = renderToStaticMarkup(createElement(LetSomeoneIn, { onClose: noop, onToken: noop, onLink: noop, onShare: noop }));
    expect(html).toContain("A token, an agent, a link or a share.");
    const order = ["Token", "Agent", "Link", "Share"].map((t) => html.indexOf(`</span>${t}</span>`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("takes a name and a role, Operator ticked, and never offers Owner", () => {
    const html = renderToStaticMarkup(createElement(LetSomeoneIn, { initial: "agent", onClose: noop, onToken: noop, onLink: noop, onShare: noop }));
    expect(html).toContain("Name · shown on everything it saves");
    expect(html).toContain("agent: claude</span> in Access, Watch and on Home");
    expect(html).toMatch(/name="agent-role" checked=""\/><span[^>]*>Operator</);
    expect(html).toContain(">Viewer<");
    expect(html).not.toContain(">Owner<");
    expect(html).toContain("An Operator agent may");
    expect(html).toContain("make monitors, after a preview");
    expect(html).toContain("be made an Owner");
    expect(html).toContain("Make the agent");
  });

  test("an agent's name is what toposcope.sh agent takes", () => {
    expect(agentNameProblem("claude")).toBeNull();
    expect(agentNameProblem("ci-bot.2")).toBeNull();
    expect(agentNameProblem("")).not.toBeNull();
    expect(agentNameProblem("agent: claude")).not.toBeNull();
    expect(agentNameProblem("x".repeat(58))).not.toBeNull();
  });
});

describe("an agent made (34b)", () => {
  const made = { name: "agent: claude", role: "operator" as const, token };

  test("its token is in the setup, masked on screen; the copy carries it whole", () => {
    const html = renderToStaticMarkup(createElement(AgentMade, { made, me: "Ian", origin: "https://log-vm.example.com", onDone: noop }));
    expect(html).toContain("agent: claude</span> is ready");
    expect(html).toContain("Operator · made by Ian just now");
    expect(html).toContain("this is the only time it is shown");
    expect(html).toContain("claude mcp add --transport http toposcope https://log-vm.example.com/mcp");
    expect(html).toContain("Bearer ••••••••••••••••••••••••");
    expect(html).not.toContain(token);
    expect(html).toContain("Claude Code");
    expect(html).toContain("Any MCP client");
    expect(html).toContain("On the host");
    expect(html).toContain("Set up monitors and Home panels for this app&#x27;s service.");
  });

  test("each tab's setup points at this instance's /mcp", () => {
    const input = { origin: "https://log-vm.example.com/", token, name: "claude" };
    expect(mcpSetup("claude", input)).toBe(`claude mcp add --transport http toposcope https://log-vm.example.com/mcp \\\n  --header "Authorization: Bearer ${token}"`);
    expect(JSON.parse(mcpSetup("any", input))).toEqual({ mcpServers: { toposcope: { type: "http", url: "https://log-vm.example.com/mcp", headers: { Authorization: `Bearer ${token}` } } } });
    expect(mcpSetup("host", input)).toBe("./toposcope.sh agent claude");
    expect(mcpSetup("any", input, true)).not.toContain(token);
  });
});

describe("what an agent saved wears its name (34c)", () => {
  const byAgent = { id: "a1", name: "agent: claude", revoked: false, kind: "service", agent: true };
  const byIan = { id: "p1", name: "Ian", revoked: false, kind: "person", agent: false };

  test("a monitor an agent saved shows the badge in Watch; one a person made does not", () => {
    const agentRow = renderToStaticMarkup(createElement(PlaceTags, { monitor: { service: "api", host: "", made_by: byAgent } }));
    expect(agentRow).toContain("✦");
    expect(agentRow).toContain("agent: claude");
    expect(agentRow.indexOf("agent: claude")).toBeLessThan(agentRow.indexOf(">api<"));
    const personRow = renderToStaticMarkup(createElement(PlaceTags, { monitor: { service: "api", host: "", made_by: byIan } }));
    expect(personRow).not.toContain("✦");
  });

  test("Watch says how many an agent saved", () => {
    expect(agentWatchWords([{ made_by: byAgent }, { made_by: byAgent }, { made_by: byIan }, {}])).toEqual({ count: 2, by: "agent: claude" });
    expect(agentWatchWords([{ made_by: byAgent }, { made_by: { ...byAgent, name: "agent: ci" } }])).toEqual({ count: 2, by: "agents" });
    expect(agentWatchWords([{ made_by: byIan }])).toBeNull();
  });

  test("the badge opens Access when it can", () => {
    expect(renderToStaticMarkup(createElement(AgentBadge, { name: "agent: claude", onOpen: noop }))).toContain('role="link"');
    expect(renderToStaticMarkup(createElement(AgentBadge, { name: "agent: claude" }))).not.toContain('role="link"');
  });
});

describe("Access's Agents group (34c)", () => {
  const agent: PersonRow = {
    id: "a1", kind: "service", agent: true, made_on_host: false, name: "agent: claude", email: null, role: "operator", initials: "AC", you: false,
    signs_in_with: "tokens only", last_seen_at: null, created_at: Date.parse("2026-10-28T12:58:00Z"), invited_by: "Ian", first_owner: false,
    tokens: [{ id: "t1", name: "made in Access", read_only: false, created_at: 0, expires_at: now + 1e10, last_used_at: Date.parse("2026-10-28T13:04:00Z") }],
    saved: { monitors: 2, home_panels: 2, hunts: 0 },
  };

  test("a row: its kind, name, who made it, role, tokens and last call, what it saved, Revoke", () => {
    const html = renderToStaticMarkup(createElement(AgentsGroup, { agents: [agent], nowMs: now, isOwner: true, onChanged: noop }));
    expect(html).toContain(">Agents<");
    expect(html).toContain("service accounts made for a coding agent");
    expect(html).toContain("✦ agent");
    expect(html).toContain("agent: claude");
    expect(html).toContain("made by Ian today at");
    expect(html).toContain(">Operator<");
    expect(html).toContain("1 token · last call");
    expect(html).toContain("saved 2 monitors, 2 Home panels");
    expect(html).toContain(">Revoke<");
    expect(renderToStaticMarkup(createElement(AgentsGroup, { agents: [agent], nowMs: now, isOwner: false, onChanged: noop }))).not.toContain("Revoke");
    expect(renderToStaticMarkup(createElement(AgentsGroup, { agents: [], nowMs: now, isOwner: true, onChanged: noop }))).toBe("");
  });

  test("words for what it saved and who made it", () => {
    expect(agentSavedWords({ monitors: 1, home_panels: 0, hunts: 3 })).toBe("saved 1 monitor, 3 saved hunts");
    expect(agentSavedWords({ monitors: 0, home_panels: 0, hunts: 0 })).toBe("saved nothing yet");
    expect(agentMadeWords({ ...agent, made_on_host: true, invited_by: null }, now)).toMatch(/^made on the host today at \d\d:\d\d$/);
    expect(agentMadeWords({ ...agent, created_at: now - 3 * 86_400_000 }, now)).toMatch(/^made by Ian \d\d-\d\d \d\d:\d\d$/);
  });

  test("its tokens say they are an agent's", () => {
    expect(tokenKind(agent, agent.tokens[0]!)).toBe("agent · as Operator");
  });
});
