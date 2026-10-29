import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agentMay, agentNameProblem, agentNever, agentRoleCards, mcpSetup, setupWhere, type AgentRole, type SetupTab } from "../agents";

/**
 * Let someone in › Agent (#357): 34a, a name and a role, with what an agent may and never may do;
 * Make shows 34b, its token once inside the MCP setup for Claude Code, any MCP client, or the host.
 */
/** `kept`: the agent existed already, in this role, and this is another token for it. */
export type MadeAgent = { name: string; role: AgentRole; token: string; kept?: boolean };

const lab = "text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase";

/** 34a: the form under the four cards. */
export function AgentStep(props: { onCancel: () => void; onMade: (made: MadeAgent) => void }) {
  const [name, setName] = useState("claude");
  const [role, setRole] = useState<AgentRole>("operator");
  const [busy, setBusy] = useState(false);
  const problem = agentNameProblem(name);
  const shown = name.trim() || "<name>";

  async function make() {
    setBusy(true);
    try {
      const res = await fetch("/api/people/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), role }) });
      const body = (await res.json().catch(() => null)) as { token?: string; kept?: boolean; agent?: { name: string }; error?: string } | null;
      if (!res.ok || !body?.token) {
        toast.error(body?.error ?? `The agent was not made (${res.status})`);
        return;
      }
      props.onMade({ name: body.agent?.name ?? `agent: ${name.trim()}`, role, token: body.token, kept: body.kept === true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) {
          void make();
        }
      }}
    >
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <label htmlFor="agent-name" className={lab}>
          Name · shown on everything it saves
        </label>
        <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus className="h-[34px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[13px] outline-none" />
        <span className={cn("text-[12px]", problem && name.trim() ? "text-red-300" : "text-muted-foreground")}>
          {problem && name.trim() ? (
            problem
          ) : (
            <>
              It appears as <span className="font-mono text-zinc-300">agent: {shown}</span> in Access, Watch and on Home.
            </>
          )}
        </span>
      </div>

      <fieldset className="m-0 grid grid-cols-1 gap-2.5 border-0 p-0 md:grid-cols-2">
        <legend className={cn(lab, "pb-1.5")}>Role</legend>
        {agentRoleCards.map((card) => (
          <label
            key={card.role}
            className={cn("grid cursor-pointer grid-cols-[18px_1fr] items-start gap-x-2.5 gap-y-1 rounded-[8px] border bg-[#0d0d0f] px-3.5 py-3", role === card.role ? "border-plate bg-[#1a1a1e]" : "border-white/10 hover:border-zinc-500")}
          >
            <input type="radio" name="agent-role" checked={role === card.role} onChange={() => setRole(card.role)} className="mt-0.5 size-[15px] accent-[#e7e1d3]" />
            <span className="text-[13px] font-medium text-foreground">{card.name}</span>
            <span className="col-start-2 text-[11.5px] leading-[1.45] text-muted-foreground">{card.words}</span>
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 rounded-[10px] border border-white/10 bg-[#0d0d0f] px-4 py-3.5 md:grid-cols-2">
        <div className="flex flex-col gap-1.5 text-[12.5px] text-zinc-300">
          <span className={cn(lab, "mb-0.5")}>{role === "operator" ? "An Operator agent may" : "A Viewer agent may"}</span>
          {agentMay[role].map((line) => (
            <span key={line} className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] text-emerald-300">✓</span>
              {line}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 text-[12.5px] text-zinc-300">
          <span className={cn(lab, "mb-0.5")}>and never</span>
          {agentNever[role].map((line) => (
            <span key={line} className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] text-muted-foreground">—</span>
              {line}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="submit" disabled={busy || problem !== null}>
          Make the agent
        </Button>
        <Button type="button" variant="ghost" className="text-muted-foreground" onClick={props.onCancel}>
          Cancel
        </Button>
        <div className="flex-1" />
        <span className="text-[12px] text-muted-foreground">Its token is shown once, with the setup for Claude Code and any MCP client.</span>
      </div>
    </form>
  );
}

const tabs: Array<{ id: SetupTab; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "any", label: "Any MCP client" },
  { id: "host", label: "On the host" },
];

/** 34b: the agent made. Its token is in the setup, masked on screen and whole in the copy, this once. */
export function AgentMade(props: { made: MadeAgent; me: string | null; origin: string; onDone: () => void }) {
  const [tab, setTab] = useState<SetupTab>("claude");
  const bare = props.made.name.replace(/^agent: /, "");
  const input = { origin: props.origin, token: props.made.token, name: bare };
  const operator = props.made.role === "operator";
  return (
    <>
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[17px] font-semibold">
          <span className="font-mono font-medium">{props.made.name}</span> is ready
        </h2>
        <span className="text-[12px] text-muted-foreground">
          {operator ? "Operator" : "Viewer"}
          {props.me ? ` · made by ${props.me} just now` : " · made just now"}
        </span>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={props.onDone}>
          Close
        </Button>
      </div>

      <div className="flex items-center gap-3 rounded-[10px] border border-[#7c5f1a] bg-[#17130b] px-3.5 py-3">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="shrink-0">
          <path d="M12 4 L21 19 H3 Z" fill="none" stroke="#fbbf24" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 10 V14" stroke="#fbbf24" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="text-[13px] text-amber-200">Its token is in the setup below, and this is the only time it is shown. Copy it now, or close and make another.</span>
      </div>
      {props.made.kept ? (
        <p className="m-0 text-[12.5px] text-zinc-300">
          <span className="font-mono">{props.made.name}</span> already existed; this is a new token, and its earlier tokens still work (revoke them in its row).
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <span className={lab}>Connect it</span>
        <span className="inline-flex overflow-hidden rounded-[7px] border border-white/10">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-pressed={tab === t.id} className={cn("px-3 py-[7px] text-[12.5px]", tab === t.id ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </span>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-white/10 bg-[#09090b]">
        <div className="flex items-center gap-2 border-b border-white/[0.06] py-1.5 pr-2 pl-3.5">
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{setupWhere[tab]}</span>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => void navigator.clipboard.writeText(mcpSetup(tab, input)).then(() => toast.success("Copied"))}
          >
            Copy
          </Button>
        </div>
        <pre className="m-0 px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] break-all whitespace-pre-wrap text-zinc-300">{mcpSetup(tab, input, true)}</pre>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className={lab}>Then ask it</span>
          <div className="rounded-[12px] bg-plate px-3.5 py-3 text-[13.5px] leading-[1.45] text-[#0d0d0f]">
            {operator ? "Set up monitors and Home panels for this app's service." : "What changed in this app's errors since the last deploy?"}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className={lab}>What it will do</span>
          <span className="text-[13px] leading-[1.55] text-zinc-300">
            {operator
              ? "Propose monitors and panels, preview each over the last 7 days, and save only what you say yes to, under its own name."
              : "Search, trace and compare around marks, and save hunts of its own. It changes nothing anyone else sees."}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <Button type="button" onClick={props.onDone}>
          Done
        </Button>
        <div className="flex-1" />
        <span className="text-[12px] text-muted-foreground">Revoke it any time from its row in Access.</span>
      </div>
    </>
  );
}
