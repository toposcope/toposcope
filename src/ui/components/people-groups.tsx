import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clockAt } from "../watch";
import { agentSavedWords } from "../agents";
import { dayAt } from "./me-menu";

/**
 * People in Access (#308): the People group (30a), Invite someone (30b), service accounts and
 * Make a token (32f). An Owner changes roles, invites and revokes; everyone else reads.
 */
export type Role = "viewer" | "operator" | "owner";
export type PersonTokenRow = { id: string; name: string; read_only: boolean; created_at: number; expires_at: number; last_used_at: number | null };
export type PersonRow = {
  id: string;
  kind: "person" | "service";
  /** An agent (#357): a service account made for a coding agent, named `agent: <name>`. */
  agent?: boolean;
  /** An agent's: made by `toposcope.sh agent` on the host, and what it saved (34c). */
  made_on_host?: boolean;
  saved?: { monitors: number; home_panels: number; hunts: number };
  name: string;
  email: string | null;
  role: Role;
  initials: string;
  you: boolean;
  signs_in_with: string;
  last_seen_at: number | null;
  created_at: number;
  invited_by: string | null;
  first_owner: boolean;
  tokens: PersonTokenRow[];
  two_step?: { state: "on" | "not set up" | "reset" | "provider" | "none"; codes_left: number; reset_by: string | null; reset_at: number | null; remembered?: { count: number; until: number | null } };
};

/** What People says about a person's second step (32e). */
export function twoStepWords(p: PersonRow, nowMs: number): { text: string; tone: "ok" | "warn" | "muted" } {
  const t = p.two_step;
  if (!t || t.state === "none") {
    return { text: "—", tone: "muted" };
  }
  if (t.state === "provider") {
    return { text: "not needed · their provider does it", tone: "muted" };
  }
  if (t.state === "on") {
    return { text: `● on · ${t.codes_left} backup code${t.codes_left === 1 ? "" : "s"}${t.codes_left <= 3 ? " left" : ""}`, tone: "ok" };
  }
  if (t.state === "reset") {
    return { text: `● set up again at next sign-in${t.reset_by ? ` · reset by ${t.reset_by}` : ""}${t.reset_at ? ` ${clockAt(t.reset_at, nowMs)}` : ""}`, tone: "warn" };
  }
  return { text: "● not set up · asked at next sign-in", tone: "warn" };
}
/** 34g: the second line under Two-step, the browsers that skip their code. */
export function rememberedWords(p: PersonRow): string | null {
  const t = p.two_step;
  if (t?.state !== "on") {
    return null;
  }
  const n = t.remembered?.count ?? 0;
  if (n === 0) {
    return "no browser remembered";
  }
  return `${n} ${n === 1 ? "browser" : "browsers"} remembered${t.remembered?.until ? ` · until ${dayAt(t.remembered.until)}` : ""}`;
}
export type InviteRow = { id: string; who: string; role: Role; created_at: number; expires_at: number; invited_by: string | null };
export type PeopleBody = { people: PersonRow[]; service_accounts: PersonRow[]; agents?: PersonRow[]; invites: InviteRow[] };

export const roleName: Record<Role, string> = { viewer: "Viewer", operator: "Operator", owner: "Owner" };

/** The three role cards of 30b: what each can and cannot do. */
export const roleCards: Array<{ role: Role; can: string; cannot: string }> = [
  { role: "viewer", can: "Reads everything: Home, Hunt, Watch, traces. Saves their own hunts.", cannot: "Cannot change monitors, Access, retention or settings." },
  { role: "operator", can: "Everything a Viewer does, plus monitors, notes, shared hunts, Fields and shares' panels.", cannot: "Cannot let people in or change retention." },
  { role: "owner", can: "Everything, including people, tokens, links, shares, retention and sign-in.", cannot: "Keep this to two or three people." },
];

/** "in 6 d", "in 5 h": how long an invite has left. */
export function expiresIn(expiresAt: number, nowMs: number): string {
  const ms = expiresAt - nowMs;
  if (ms <= 0) {
    return "expired";
  }
  const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `in ${days} d` : `in ${Math.max(1, Math.floor(ms / 3_600_000))} h`;
}

/** How a token row names its kind in words (32f). */
export function tokenKind(owner: PersonRow, token: PersonTokenRow): string {
  if (owner.agent) {
    return `agent · as ${roleName[owner.role]}`;
  }
  if (owner.kind === "service") {
    return `service · as ${roleName[owner.role]}`;
  }
  return token.read_only ? "personal · read-only" : `personal · as ${roleName[owner.role]}`;
}

const avatarTone: string[] = ["#e7e1d3", "#60a5fa", "#2dd4bf", "#c4b5fd", "#fbbf24", "#f9a8d4"];
function tone(id: string): string {
  let n = 0;
  for (const ch of id) {
    n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return avatarTone[n % avatarTone.length]!;
}

const peopleCol = "grid grid-cols-[36px_minmax(0,1fr)_110px_120px_230px_110px_150px_96px] items-center gap-3";

export function PeopleGroup(props: { body: PeopleBody; nowMs: number; isOwner: boolean; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);

  async function call(url: string, init: RequestInit, done: string) {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
    setArmed(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Failed (${res.status})`);
      return;
    }
    toast.success(done);
    props.onChanged();
  }

  return (
    <section aria-label="People" className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
      <div className="flex flex-wrap items-baseline gap-2.5 px-4 py-2.5">
        <h2 className="m-0 text-[13.5px] font-medium">People</h2>
        <span className="text-[12px] text-muted-foreground">sign in to this instance and see what their role lets them</span>
      </div>
      <div className={cn(peopleCol, "border-t border-white/[0.06] px-4 py-1.5 text-[11px] tracking-[0.04em] text-muted-foreground uppercase")}>
        <span />
        <span>Name</span>
        <span>Role</span>
        <span>Signs in with</span>
        <span>Two-step</span>
        <span>Last seen</span>
        <span>Invited by</span>
        <span />
      </div>
      {props.body.people.map((p) => (
        <div key={p.id} className={cn(peopleCol, "border-t border-white/[0.06] px-4 py-2 text-[12.5px]")}>
          <span className="inline-flex size-[30px] items-center justify-center rounded-full text-[11px] font-semibold text-[#0d0d0f]" style={{ background: tone(p.id) }}>
            {p.initials}
          </span>
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{p.name}</span>
            <span className="text-muted-foreground">
              {p.you ? " · you" : ""}
              {p.email ? ` · ${p.email}` : ""}
            </span>
          </span>
          {props.isOwner ? (
            <select
              aria-label={`Role of ${p.name}`}
              value={p.role}
              className={cn("h-6 w-fit rounded-[6px] border bg-transparent px-1.5 text-[11.5px]", p.role === "owner" ? "border-plate text-foreground" : "border-white/10 text-zinc-300")}
              onChange={(e) => void call(`/api/people/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify({ role: e.target.value }) }, `${p.name} is now ${roleName[e.target.value as Role]}`)}
            >
              {(["viewer", "operator", "owner"] as const).map((r) => (
                <option key={r} value={r}>
                  {roleName[r]}
                </option>
              ))}
            </select>
          ) : (
            <span className={cn("inline-flex h-6 w-fit items-center rounded-[6px] border px-2 text-[11.5px]", p.role === "owner" ? "border-plate text-foreground" : "border-white/10 text-zinc-300")}>
              {roleName[p.role]}
            </span>
          )}
          <span className="truncate text-[12px] text-muted-foreground">{p.signs_in_with}</span>
          {(() => {
            const w = twoStepWords(p, props.nowMs);
            const r = rememberedWords(p);
            return (
              <span className="flex min-w-0 flex-col gap-px">
                <span className={cn("truncate text-[12px]", w.tone === "ok" ? "text-emerald-300" : w.tone === "warn" ? "text-amber-300" : "text-muted-foreground")}>{w.text}</span>
                {r ? <span className={cn("truncate text-[11.5px]", armed === `rb:${p.id}` ? "text-plate" : "text-muted-foreground")}>{r}</span> : null}
              </span>
            );
          })()}
          <span className="truncate font-mono text-[12px] text-muted-foreground">{p.you ? "now" : p.last_seen_at ? clockAt(p.last_seen_at, props.nowMs) : "never"}</span>
          <span className="truncate text-[12px] text-muted-foreground">{p.first_owner ? "first Owner, from the setup link" : p.invited_by ? `${p.invited_by} · ${clockAt(p.created_at, props.nowMs)}` : "—"}</span>
          <span className="flex flex-col items-end gap-0.5 text-right">
            {props.isOwner && !p.you && p.two_step?.state === "on" ? (
              armed === `2s:${p.id}` ? (
                <button
                  type="button"
                  className="text-[12px] text-plate hover:underline"
                  title="Their sessions end now, their backup codes stop working, their remembered browsers are forgotten, and they set up two-step again the next time they sign in."
                  onClick={() => void call(`/api/people/${encodeURIComponent(p.id)}/two-step`, { method: "DELETE" }, `${p.name}'s two-step is reset`)}
                >
                  sure? reset two-step
                </button>
              ) : (
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(`2s:${p.id}`)}>
                  reset two-step
                </button>
              )
            ) : null}
            {props.isOwner && !p.you && (p.two_step?.remembered?.count ?? 0) > 0 ? (
              armed === `rb:${p.id}` ? (
                <button
                  type="button"
                  className="text-[12px] text-plate underline"
                  title="Each of their remembered browsers asks for the code at its next sign-in. Nobody is signed out."
                  onClick={() => void call(`/api/people/${encodeURIComponent(p.id)}/remembered-browsers`, { method: "DELETE" }, `${p.name}'s browsers are forgotten`)}
                >
                  sure? forget {p.two_step!.remembered!.count}
                </button>
              ) : (
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(`rb:${p.id}`)}>
                  forget browsers
                </button>
              )
            ) : null}
            {props.isOwner && !p.you ? (
              armed === p.id ? (
                <button type="button" className="text-[12px] text-red-300 hover:underline" onClick={() => void call(`/api/people/${encodeURIComponent(p.id)}`, { method: "DELETE" }, `${p.name} revoked`)}>
                  sure? revoke
                </button>
              ) : (
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(p.id)}>
                  revoke
                </button>
              )
            ) : null}
          </span>
        </div>
      ))}
      {props.body.invites.map((i) => (
        <div key={i.id} className={cn(peopleCol, "border-t border-white/[0.06] px-4 py-2 text-[12.5px] opacity-75")}>
          <span className="inline-flex size-[30px] items-center justify-center rounded-full bg-[#3f3f46] text-[11px] font-semibold text-zinc-300">?</span>
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{i.who}</span>
            <span className="text-muted-foreground"> · invite not used yet · expires {expiresIn(i.expires_at, props.nowMs)}</span>
          </span>
          <span className="inline-flex h-6 w-fit items-center rounded-[6px] border border-white/10 px-2 text-[11.5px] text-zinc-300">{roleName[i.role]}</span>
          <span className="text-[12px] text-muted-foreground">—</span>
          <span className="text-[12px] text-muted-foreground">—</span>
          <span className="font-mono text-[12px] text-muted-foreground">never</span>
          <span className="truncate text-[12px] text-muted-foreground">{i.invited_by ? `${i.invited_by} · ${clockAt(i.created_at, props.nowMs)}` : "—"}</span>
          <span className="text-right">
            {props.isOwner ? (
              <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => void call(`/api/people/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" }, "Invite cancelled")}>
                cancel
              </button>
            ) : null}
          </span>
        </div>
      ))}
    </section>
  );
}

/** 30a's three cards under People, with 32g's middle card. */
export function PeopleCards() {
  const card = "flex flex-col gap-1.5 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5";
  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
      <section className={card}>
        <span className="text-[13.5px] font-medium">Who did what</span>
        <span className="text-[12px] leading-[1.5] text-muted-foreground">Notes, monitors, retention and every Access change carry the name of the person who made them. Machines keep their token's name.</span>
      </section>
      <section className={card}>
        <span className="text-[13.5px] font-medium">The first Owner</span>
        <span className="text-[12px] leading-[1.5] text-muted-foreground">
          There is no shared password. The first Owner was made from a one-time link printed on the host. If every Owner is locked out, <span className="font-mono text-zinc-300">toposcope.sh owner-link &lt;email&gt;</span> on the host makes a new one.
        </span>
      </section>
      <section className={card}>
        <span className="text-[13.5px] font-medium">Revoke is immediate</span>
        <span className="text-[12px] leading-[1.5] text-muted-foreground">Their sessions end on the next request. What they made stays, still under their name.</span>
      </section>
    </div>
  );
}

/** 32f: service accounts, a group of their own above Tokens. */
export function ServiceAccountsGroup(props: { accounts: PersonRow[]; nowMs: number; isOwner: boolean; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  if (props.accounts.length === 0) {
    return null;
  }
  async function revoke(p: PersonRow) {
    const res = await fetch(`/api/people/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    setArmed(null);
    if (!res.ok) {
      toast.error(`Revoke failed (${res.status})`);
      return;
    }
    toast.success(`${p.name} revoked`);
    props.onChanged();
  }
  const col = "grid grid-cols-[minmax(0,1fr)_150px_160px_72px] items-center gap-3";
  return (
    <section aria-label="Service accounts" className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
      <div className="flex flex-wrap items-baseline gap-2.5 px-4 py-2.5">
        <h2 className="m-0 text-[13.5px] font-medium">Service accounts</h2>
        <span className="text-[12px] text-muted-foreground">People rows that cannot sign in; they only hold tokens. For scripts that are not a person.</span>
      </div>
      {props.accounts.map((p) => {
        const used = p.tokens.reduce<number | null>((m, t) => (t.last_used_at && (!m || t.last_used_at > m) ? t.last_used_at : m), null);
        return (
          <div key={p.id} className={cn(col, "border-t border-white/[0.06] px-4 py-2 text-[12.5px]")}>
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">{p.name}</span>
              <span className="text-muted-foreground">
                {p.invited_by ? ` · made by ${p.invited_by}` : ""} · {p.tokens.length} token{p.tokens.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="inline-flex h-[22px] w-fit items-center rounded-[5px] border border-white/10 px-2 text-[11px] text-zinc-300">{roleName[p.role]}</span>
            <span className="truncate font-mono text-[12px] text-muted-foreground">{used ? clockAt(used, props.nowMs) : "never"}</span>
            <span className="text-right">
              {props.isOwner ? (
                armed === p.id ? (
                  <button type="button" className="text-[12px] text-red-300 hover:underline" onClick={() => void revoke(p)}>
                    sure? revoke
                  </button>
                ) : (
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(p.id)}>
                    revoke
                  </button>
                )
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** "made by Ian today at 12:58", "made on the host 10-27 09:14" (34c). */
export function agentMadeWords(p: Pick<PersonRow, "invited_by" | "made_on_host" | "created_at">, nowMs: number): string {
  const by = p.made_on_host ? "on the host" : p.invited_by ? `by ${p.invited_by}` : "";
  const at = clockAt(p.created_at, nowMs);
  return `made${by ? ` ${by}` : ""} ${at.includes(" ") ? at : `today at ${at}`}`;
}

/** 34c: agents, a group of their own above Service accounts: role, last call, what each saved, Revoke. */
export function AgentsGroup(props: { agents: PersonRow[]; nowMs: number; isOwner: boolean; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  if (props.agents.length === 0) {
    return null;
  }
  async function revoke(p: PersonRow) {
    const res = await fetch(`/api/people/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    setArmed(null);
    if (!res.ok) {
      toast.error(`Revoke failed (${res.status})`);
      return;
    }
    toast.success(`${p.name} revoked; what it saved stays`);
    props.onChanged();
  }
  const col = "grid grid-cols-[110px_minmax(0,1fr)_140px_160px_minmax(0,260px)_90px] items-center gap-3.5";
  return (
    <section aria-label="Agents" className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
      <div className="flex flex-wrap items-baseline gap-2.5 border-b border-white/[0.06] px-4 py-2.5">
        <h2 className="m-0 text-[13.5px] font-medium">Agents</h2>
        <span className="text-[12px] text-muted-foreground">service accounts made for a coding agent</span>
      </div>
      {props.agents.map((p, i) => {
        const used = p.tokens.reduce<number | null>((m, t) => (t.last_used_at && (!m || t.last_used_at > m) ? t.last_used_at : m), null);
        return (
          <div key={p.id} id={`agent-${p.id}`} className={cn(col, i > 0 && "border-t border-white/[0.06]", "px-4 py-[11px] text-[13px]")}>
            <span className="inline-flex h-6 items-center gap-1.5 justify-self-start rounded-[6px] border border-white/10 px-2 text-[11.5px] whitespace-nowrap text-zinc-300">✦ agent</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-foreground">{p.name}</span>
              <span className="truncate text-[12px] text-muted-foreground">{agentMadeWords(p, props.nowMs)}</span>
            </span>
            <span className="text-[12px] text-muted-foreground">{roleName[p.role]}</span>
            <span className="truncate text-[12px] text-muted-foreground">
              {p.tokens.length} token{p.tokens.length === 1 ? "" : "s"} · {used ? `last call ${clockAt(used, props.nowMs)}` : "no call yet"}
            </span>
            <span className="truncate text-[12px] text-muted-foreground">{agentSavedWords(p.saved)}</span>
            <span className="justify-self-end">
              {props.isOwner ? (
                armed === p.id ? (
                  <Button type="button" size="sm" variant="outline" className="h-8 text-[12.5px] text-red-300" onClick={() => void revoke(p)}>
                    sure? revoke
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="outline" className="h-8 text-[12.5px]" onClick={() => setArmed(p.id)}>
                    Revoke
                  </Button>
                )
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** Personal and service tokens, as rows in the Tokens group, each saying its kind in words (32f). */
export function PersonTokenRows(props: { body: PeopleBody; nowMs: number; meId: string | null; isOwner: boolean; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  const rows = [...(props.body.agents ?? []), ...props.body.service_accounts, ...props.body.people].flatMap((owner) => owner.tokens.map((token) => ({ owner, token })));
  async function revoke(id: string, name: string) {
    const res = await fetch(`/api/me/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    setArmed(null);
    if (!res.ok) {
      toast.error(`Revoke failed (${res.status})`);
      return;
    }
    toast.success(`${name} revoked`);
    props.onChanged();
  }
  const col = "grid grid-cols-[150px_minmax(0,1.6fr)_minmax(0,1fr)_100px_160px_96px_72px] items-center gap-4";
  return (
    <>
      {rows.map(({ owner, token }) => (
        <div key={token.id} className={cn(col, "border-t border-white/[0.06] px-4 py-2.5 text-[12.5px]")}>
          <span className="inline-flex h-6 items-center gap-1.5 justify-self-start rounded-[6px] border border-white/10 px-2 text-[11.5px] whitespace-nowrap text-zinc-300">{tokenKind(owner, token)}</span>
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{token.name}</span> <span className="text-muted-foreground">· {owner.name}</span>
          </span>
          <span className="truncate font-mono text-[12px] text-muted-foreground">{token.read_only ? "reads" : `as ${roleName[owner.role]}`}</span>
          <span className="text-[12px] text-muted-foreground">{expiresIn(token.expires_at, props.nowMs)}</span>
          <span className="truncate font-mono text-[12px] text-muted-foreground">{token.last_used_at ? clockAt(token.last_used_at, props.nowMs) : "never"}</span>
          <span />
          <span className="text-right">
            {props.isOwner || owner.id === props.meId ? (
              armed === token.id ? (
                <button type="button" className="text-[12px] text-red-300 hover:underline" onClick={() => void revoke(token.id, token.name)}>
                  sure? revoke
                </button>
              ) : (
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(token.id)}>
                  revoke
                </button>
              )
            ) : null}
          </span>
        </div>
      ))}
    </>
  );
}

function Sheet(props: { label: string; width: number; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/55" aria-hidden="true" onClick={props.onClose} />
      <section
        aria-label={props.label}
        className="fixed top-[64px] left-1/2 z-40 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-5 rounded-[12px] border border-zinc-700 bg-[#121214] px-7 py-6 shadow-[0_30px_80px_rgba(0,0,0,.7)]"
        style={{ width: props.width }}
      >
        {props.children}
      </section>
    </>
  );
}

const lab = "text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase";
const input = "h-9 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-3 text-[13.5px] outline-none";

function ShownOnce(props: { label: string; value: string; note: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-dashed border-plate px-4 py-3.5">
      <span className={cn(lab, "text-plate")}>{props.label}</span>
      <div className="flex items-center gap-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">{props.value}</code>
        <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(props.value).then(() => toast.success("Copied"))}>
          Copy
        </Button>
      </div>
      <span className="text-[12px] text-muted-foreground">{props.note}</span>
    </div>
  );
}

/** 30b: Invite someone. An email or a name, a role from three cards, a link shown once. */
export function InviteSheet(props: { onClose: () => void; onInvited: () => void }) {
  const [who, setWho] = useState("");
  const [days, setDays] = useState(7);
  const [role, setRole] = useState<Role>("viewer");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    try {
      const res = await fetch("/api/people/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who, role, days }) });
      const body = (await res.json().catch(() => null)) as { link?: string; error?: string } | null;
      if (!res.ok || !body?.link) {
        toast.error(body?.error ?? `The invite was not made (${res.status})`);
        return;
      }
      setLink(body.link);
      props.onInvited();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet label="Invite someone" width={900} onClose={props.onClose}>
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[17px] font-semibold">Invite someone</h2>
        <span className="text-[12.5px] text-muted-foreground">They get a link that works once. No mail server needed: send it however you like.</span>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={props.onClose} aria-label="Close">
          ×
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className={lab} htmlFor="invite-who">
            Email or a name
          </label>
          <input id="invite-who" className={input} value={who} onChange={(e) => setWho(e.target.value)} placeholder="sam@contractor.dev" disabled={link !== null} />
          <span className="text-[12px] text-muted-foreground">With an email, they sign in as that address.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={lab} htmlFor="invite-days">
            Link works for
          </label>
          <select id="invite-days" className={input} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={link !== null}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className={lab}>Role</span>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {roleCards.map((card) => (
            <button
              key={card.role}
              type="button"
              aria-pressed={role === card.role}
              disabled={link !== null}
              className={cn("flex flex-col gap-2 rounded-[10px] border bg-[#0d0d0f] px-4 py-3.5 text-left", role === card.role ? "border-plate bg-[#1a1a1e]" : "border-white/10 hover:border-zinc-500")}
              onClick={() => setRole(card.role)}
            >
              <span className="text-[14px] font-semibold">{roleName[card.role]}</span>
              <span className="text-[12.5px] leading-[1.5] text-zinc-400">{card.can}</span>
              <span className="text-[12px] text-zinc-300">{card.cannot}</span>
            </button>
          ))}
        </div>
      </div>
      {link ? (
        <ShownOnce label="Shown once" value={link} note={'Shows under People as "invite not used yet" until they sign in. Cancel it there.'} />
      ) : null}
      <div className="flex items-center gap-2.5">
        {link ? (
          <Button type="button" onClick={props.onClose}>
            Done
          </Button>
        ) : (
          <Button type="button" disabled={busy || !who.trim()} onClick={() => void invite()}>
            Invite as {roleName[role]}
          </Button>
        )}
        <Button type="button" variant="ghost" className="text-muted-foreground" onClick={props.onClose}>
          Cancel
        </Button>
        <div className="flex-1" />
        <span className="text-[12px] text-muted-foreground">Only an Owner sees this button.</span>
      </div>
    </Sheet>
  );
}

/** 32f: Make a token, for me, a service account, or sending logs in. */
export function MakeTokenSheet(props: { me: { id: string; name: string; role: Role }; accounts: PersonRow[]; isOwner: boolean; onClose: () => void; onMade: () => void }) {
  const [forWhom, setFor] = useState<"me" | "service" | "ingest">("me");
  const [account, setAccount] = useState<string>(props.accounts[0]?.id ?? "new");
  const [newAccount, setNewAccount] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");
  const [readOnly, setReadOnly] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState(365);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function make() {
    setBusy(true);
    try {
      let url = "/api/me/tokens";
      let body: Record<string, unknown> = { name, read_only: readOnly, expires_in_days: days };
      if (forWhom === "ingest") {
        url = "/api/api-tokens";
        body = { name };
      } else if (forWhom === "service") {
        let id = account;
        if (account === "new") {
          const made = await fetch("/api/people/service-accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newAccount, role: newRole }) });
          const made_body = (await made.json().catch(() => null)) as { id?: string; error?: string } | null;
          if (!made.ok || !made_body?.id) {
            toast.error(made_body?.error ?? `The service account was not made (${made.status})`);
            return;
          }
          id = made_body.id;
        }
        url = `/api/people/${encodeURIComponent(id)}/tokens`;
      }
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !out?.token) {
        toast.error(out?.error ?? `The token was not made (${res.status})`);
        return;
      }
      setToken(out.token);
      props.onMade();
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ id: "me" | "service" | "ingest"; title: string; words: string; owner: boolean }> = [
    { id: "me", title: `Me · ${props.me.name}`, words: "Acts as you, for your own scripts. Dies when you are revoked.", owner: false },
    { id: "service", title: "A service account", words: "For a deploy script or a sync. It does not belong to a person.", owner: true },
    { id: "ingest", title: "Sending logs in", words: "An ingest token: writes rows and marks, reads nothing.", owner: true },
  ];

  return (
    <Sheet label="Make a token" width={520} onClose={props.onClose}>
      <h2 className="m-0 text-[16px] font-semibold">Make a token</h2>
      <div className="flex flex-col gap-2">
        <span className={lab}>For</span>
        {options
          .filter((o) => props.isOwner || !o.owner)
          .map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={forWhom === o.id}
              disabled={token !== null}
              className={cn("flex flex-col gap-1 rounded-[8px] border px-3 py-2.5 text-left text-[12.5px] text-zinc-400", forWhom === o.id ? "border-plate bg-[#1a1a1e]" : "border-white/10")}
              onClick={() => setFor(o.id)}
            >
              <span className="text-[13px] font-medium text-foreground">{o.title}</span>
              {o.words}
            </button>
          ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {forWhom === "service" ? (
          <div className="flex flex-col gap-1.5">
            <label className={lab} htmlFor="tok-account">
              Service account
            </label>
            <select id="tok-account" className={input} value={account} onChange={(e) => setAccount(e.target.value)} disabled={token !== null}>
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {roleName[a.role]}
                </option>
              ))}
              <option value="new">New service account…</option>
            </select>
          </div>
        ) : null}
        {forWhom === "service" && account === "new" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label className={lab} htmlFor="tok-new">
                Its name
              </label>
              <input id="tok-new" className={input} value={newAccount} onChange={(e) => setNewAccount(e.target.value)} placeholder="agental-boards" disabled={token !== null} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={lab} htmlFor="tok-role">
                Its role
              </label>
              <select id="tok-role" className={input} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} disabled={token !== null}>
                {(["viewer", "operator", "owner"] as const).map((r) => (
                  <option key={r} value={r}>
                    {roleName[r]}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {forWhom !== "ingest" ? (
          <div className="flex flex-col gap-1.5">
            <label className={lab} htmlFor="tok-can">
              Can
            </label>
            <select id="tok-can" className={input} value={readOnly ? "read" : "role"} onChange={(e) => setReadOnly(e.target.value === "read")} disabled={token !== null}>
              <option value="role">do what its role allows</option>
              <option value="read">read only</option>
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label className={lab} htmlFor="tok-name">
            Name
          </label>
          <input id="tok-name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={forWhom === "ingest" ? "boxes" : "board sync"} disabled={token !== null} />
        </div>
        {forWhom !== "ingest" ? (
          <div className="flex flex-col gap-1.5">
            <label className={lab} htmlFor="tok-days">
              Expires
            </label>
            <select id="tok-days" className={input} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={token !== null}>
              <option value={30}>in 30 days</option>
              <option value={90}>in 90 days</option>
              <option value={365}>in 1 year</option>
            </select>
          </div>
        ) : null}
      </div>
      {token ? (
        <ShownOnce
          label="Shown once"
          value={token}
          note={
            <>
              Use it as <span className="font-mono">Authorization: Bearer …</span>. Basic auth is gone in 0.9.
            </>
          }
        />
      ) : null}
      <div className="flex gap-2">
        {token ? (
          <Button type="button" onClick={props.onClose}>
            Done
          </Button>
        ) : (
          <Button type="button" disabled={busy || !name.trim() || (forWhom === "service" && account === "new" && !newAccount.trim())} onClick={() => void make()}>
            Make token
          </Button>
        )}
        <Button type="button" variant="ghost" className="text-muted-foreground" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
