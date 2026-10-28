import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AccessRefusal, AccessRow } from "../../access/list";
import { clockAt } from "../watch";
import { kindsOf, leavesWords, type LinkKind } from "../link-kinds";
import type { LinksList } from "../link-words";
import { KindChips } from "./kind-boxes";
import { MintDialog, PasteDialog } from "./link-dialogs";
import { InviteSheet, MakeTokenSheet, PeopleCards, PeopleGroup, PersonTokenRows, ServiceAccountsGroup, type PeopleBody, type Role } from "./people-groups";

/**
 * Access (#265, frames 26i and 26j; the one door since 29a, #295): every way in or out of this
 * instance other than the operator password, grouped as Tokens, Links and Shares. Each row says its
 * kind in plain words, what it does, its scope, expiry, last use, today, and one action. "Let someone
 * in" is the one door to make another.
 */
export type AccessFilter = "all" | "people" | "tokens" | "links" | "shares";

/** The chip's arrow: down for a token, toward here or away for a link or key, up for a share. */
export function accessGlyph(row: Pick<AccessRow, "kind" | "direction">): { glyph: string; color: string } {
  if (row.kind === "token") {
    return { glyph: "↓", color: "#60a5fa" };
  }
  if (row.kind === "share") {
    return { glyph: "↑", color: "#2dd4bf" };
  }
  return { glyph: row.direction === "in" ? "←" : "→", color: "#e7e1d3" };
}

export function inFilter(row: AccessRow, filter: AccessFilter): boolean {
  if (filter === "people") {
    return false;
  }
  return filter === "all" || (filter === "tokens" ? row.kind === "token" : filter === "links" ? row.kind === "link" || row.kind === "invite" : row.kind === "share");
}

/** The three groups, in order, each with its one line (29a). */
export const accessGroups: Array<{ filter: Exclude<AccessFilter, "all" | "people">; title: string; words: string }> = [
  { filter: "tokens", title: "Tokens", words: "send logs, metrics and marks here" },
  { filter: "links", title: "Links", words: "rows copied between this instance and another; what this one pulls shows in every hunt" },
  { filter: "shares", title: "Shares", words: "charts shown on another web page; counts only, never a row" },
];

/** "never expires", "in 29 d", "in 12 d · renew" (under 14 days), "—" for a link. */
export function expiryWords(row: AccessRow, nowMs: number): { text: string; soon: boolean } {
  if (row.kind === "link") {
    return { text: "—", soon: false };
  }
  if (row.expires_at === null) {
    return { text: row.kind === "invite" ? "once pasted" : "never expires", soon: false };
  }
  const days = Math.max(0, Math.round((row.expires_at - nowMs) / 86_400_000));
  return { text: `in ${days} d`, soon: days < 14 && row.kind === "share" };
}

/** The kinds of each link (by id) and key (by kid), from `GET /api/links` (#329). */
export function kindsById(list: Pick<LinksList, "links" | "keys"> | null): Map<string, { q: string; kinds: LinkKind[] }> {
  const by = new Map<string, { q: string; kinds: LinkKind[] }>();
  for (const l of list?.links ?? []) {
    by.set(l.id, { q: l.q, kinds: kindsOf(l.kinds) });
  }
  for (const k of list?.keys ?? []) {
    by.set(k.kid, { q: k.q, kinds: kindsOf(k.kinds) });
  }
  return by;
}

/**
 * "What leaves this instance" (33c): each link that copies from us and each key that will, naming
 * the kinds that go and why the rest do not; each share reads counts only.
 */
export function whatLeaves(list: Pick<LinksList, "links" | "keys"> | null, rows: readonly AccessRow[]): string {
  const out: string[] = [];
  for (const l of list?.links ?? []) {
    if (l.role === "serve") {
      out.push(leavesWords({ peer: l.peer_name || l.peer_url, q: l.q, kinds: kindsOf(l.kinds), pending: false }));
    }
  }
  for (const k of list?.keys ?? []) {
    if (k.kind === "offer") {
      out.push(leavesWords({ peer: `key ${k.label}`, q: k.q, kinds: kindsOf(k.kinds), pending: true }));
    }
  }
  for (const r of rows) {
    if (r.kind === "share") {
      out.push(`${r.name} reads counts, never a row.`);
    }
  }
  return out.length ? out.join(" ") : "Nothing: no link copies from this instance and no share reads from it.";
}

export function AccessView(props: {
  filter: AccessFilter;
  onFilter: (filter: AccessFilter) => void;
  here: string | null;
  retentionDays: number;
  onOpenHunt: (q: string) => void;
  onOpenLink: (id: string) => void;
  onOpenShare: (name: string) => void;
  onNewShare: () => void;
  /** Who is looking (#308): an Owner invites, changes roles and makes service accounts. */
  me?: { id: string; name: string; role: Role } | null;
}) {
  const [data, setData] = useState<{ rows: AccessRow[]; refusals: AccessRefusal[] } | null>(null);
  const [links, setLinks] = useState<LinksList | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [door, setDoor] = useState<"any" | "link" | null>(null);
  const [mint, setMint] = useState<"offer" | "invite" | null>(null);
  const [paste, setPaste] = useState(false);
  const [people, setPeople] = useState<PeopleBody | null>(null);
  const [inviting, setInviting] = useState(false);
  const [making, setMaking] = useState(false);
  const isOwner = props.me?.role === "owner";
  const nowMs = Date.now();
  const loadPeople = useCallback(async () => {
    const res = await fetch("/api/people");
    if (res.ok) {
      setPeople((await res.json()) as PeopleBody);
    }
  }, []);
  useEffect(() => {
    void loadPeople().catch(() => undefined);
  }, [loadPeople]);

  const load = useCallback(async () => {
    const res = await fetch("/api/access");
    if (res.ok) {
      setData((await res.json()) as { rows: AccessRow[]; refusals: AccessRefusal[] });
    }
    const list = await fetch("/api/links").catch(() => null);
    if (list?.ok) {
      setLinks((await list.json()) as LinksList);
    }
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
    const t = setInterval(() => void load().catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function revoke(row: AccessRow) {
    if (!row.revoke) {
      return;
    }
    const res = await fetch(row.revoke, { method: "DELETE" });
    setArmed(null);
    if (!res.ok) {
      toast.error(`Revoke failed (${res.status})`);
      return;
    }
    toast.success(`${row.name} revoked`);
    await load();
  }

  const rows = data?.rows ?? [];
  const personTokens = people ? [...people.people, ...people.service_accounts].reduce((n, p) => n + p.tokens.length, 0) : 0;
  const peopleCount = people ? people.people.length + people.invites.length : 0;
  const counts = {
    all: rows.length + peopleCount + personTokens,
    people: peopleCount,
    tokens: rows.filter((r) => inFilter(r, "tokens")).length + personTokens,
    links: rows.filter((r) => inFilter(r, "links")).length,
    shares: rows.filter((r) => inFilter(r, "shares")).length,
  };
  const refusedToday = rows.reduce((n, r) => n + r.today.refused, 0);
  const shown = rows.filter((r) => inFilter(r, props.filter));
  const col = "grid grid-cols-[150px_minmax(0,1.6fr)_minmax(0,1fr)_100px_160px_96px_72px] items-center gap-4";

  const kinds = kindsById(links);

  function row(r: AccessRow) {
    const exp = expiryWords(r, nowMs);
    const carries = r.kind === "link" || r.kind === "invite" ? kinds.get(r.id) : undefined;
    const g = accessGlyph(r);
    return (
      <div key={`${r.kind}-${r.id}`} className={cn(col, "border-t border-white/[0.06] px-4 py-2.5 text-[12.5px]")}>
        <span className="inline-flex h-6 items-center gap-1.5 justify-self-start rounded-[6px] border border-white/10 px-2 text-[11.5px] whitespace-nowrap text-zinc-300">
          <span style={{ color: g.color }}>{g.glyph}</span>
          {r.verb}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate">
            <span className="font-medium text-foreground">{r.name}</span> <span className="text-muted-foreground">· {r.lets_through}</span>
          </span>
          {carries ? <KindChips q={carries.q} kinds={carries.kinds} /> : null}
        </span>
        <span className="truncate font-mono text-[12px] text-muted-foreground">{r.scope}</span>
        <span className={cn("text-[12px] text-muted-foreground", exp.soon && "text-red-300")}>
          {exp.text}
          {exp.soon ? " · renew" : ""}
        </span>
        <span className="truncate font-mono text-[12px] text-muted-foreground">
          {r.last_used_at ? clockAt(r.last_used_at, nowMs) : "never"}
          {r.today.used > 0 ? ` · ${r.today.used.toLocaleString("en-US")}` : ""}
        </span>
        <span className="font-mono text-[12px]">
          {r.today.refused > 0 ? (
            <button type="button" className="text-red-300 hover:underline" onClick={() => props.onOpenHunt(`service:toposcope access:${r.name} status:refused`)}>
              {r.today.refused} refused
            </button>
          ) : r.today.used > 0 ? (
            <span className="text-emerald-300">ok</span>
          ) : (
            <span className="text-muted-foreground">quiet</span>
          )}
        </span>
        <span className="text-right">
          {r.open ? (
            <button type="button" className="text-[12px] text-zinc-300 hover:text-foreground" onClick={() => (r.kind === "link" ? props.onOpenLink(r.id) : props.onOpenShare(r.name))}>
              open
            </button>
          ) : r.revoke ? (
            armed === `${r.kind}-${r.id}` ? (
              <button type="button" className="text-[12px] text-red-300 hover:underline" onClick={() => void revoke(r)}>
                sure? revoke
              </button>
            ) : (
              <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(`${r.kind}-${r.id}`)}>
                revoke
              </button>
            )
          ) : (
            <span className="text-[11.5px] text-muted-foreground" title="Set in .env; change it there and restart">
              .env
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pt-[22px] pb-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3.5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Access</h1>
          <span className="text-[12px] text-muted-foreground">
            Everything that sends logs here, copies rows between instances, or shows charts elsewhere · {rows.length} live
            {refusedToday > 0 ? <span className="text-red-300"> · {refusedToday} refused today</span> : null}
          </span>
          <span className="inline-flex rounded-[7px] border border-white/10 bg-[#18181b] p-[2px]">
            {(["all", "people", "tokens", "links", "shares"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={props.filter === f}
                className={cn("h-[26px] rounded-[5px] px-2.5 text-[12px]", props.filter === f ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground")}
                onClick={() => props.onFilter(f)}
              >
                {f === "all" ? "All" : f === "people" ? "People" : f === "tokens" ? "Tokens" : f === "links" ? "Links" : "Shares"} · {counts[f]}
              </button>
            ))}
          </span>
          <div className="flex-1" />
          {isOwner && props.filter === "people" ? (
            <Button type="button" size="sm" onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          ) : isOwner ? (
            <Button type="button" size="sm" onClick={() => setDoor("any")}>
              Let someone in
            </Button>
          ) : null}
        </div>

        {people && (props.filter === "all" || props.filter === "people") ? (
          <PeopleGroup body={people} nowMs={nowMs} isOwner={isOwner} onChanged={() => void loadPeople()} />
        ) : null}
        {props.filter === "people" ? <PeopleCards /> : null}
        {people && (props.filter === "all" || props.filter === "tokens") ? (
          <ServiceAccountsGroup accounts={people.service_accounts} nowMs={nowMs} isOwner={isOwner} onChanged={() => void loadPeople()} />
        ) : null}

        {data && rows.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Nothing here yet. Let someone in makes the first.</p> : null}
        {accessGroups
          .filter((g) => props.filter === "all" || props.filter === g.filter)
          .map((g) => {
            const groupRows = shown.filter((r) => inFilter(r, g.filter));
            if (props.filter === "all" && groupRows.length === 0 && g.filter !== "links" && !(g.filter === "tokens" && personTokens > 0)) {
              return null;
            }
            return (
              <section key={g.filter} aria-label={g.title} className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
                <div className="flex flex-wrap items-center gap-2.5 px-4 py-2.5">
                  <h2 className="m-0 text-[13.5px] font-medium">{g.title}</h2>
                  <span className="text-[12px] text-muted-foreground">{g.words}</span>
                  <div className="flex-1" />
                  {g.filter === "links" && isOwner ? <LinkKeyButtons onMake={() => setDoor("link")} onPaste={() => setPaste(true)} /> : null}
                  {g.filter === "tokens" && props.me ? (
                    <Button type="button" size="sm" variant="outline" className="h-[26px] text-[12px]" onClick={() => setMaking(true)}>
                      Make a token
                    </Button>
                  ) : null}
                </div>
                {groupRows.length === 0 && !(g.filter === "tokens" && personTokens > 0) ? <p className="px-4 py-2.5 text-[12.5px] text-muted-foreground">None yet.</p> : null}
                {groupRows.map((r) => row(r))}
                {g.filter === "tokens" && people ? (
                  <PersonTokenRows body={people} nowMs={nowMs} meId={props.me?.id ?? null} isOwner={isOwner} onChanged={() => void loadPeople()} />
                ) : null}
              </section>
            );
          })}

        {data && props.filter !== "people" && props.filter !== "tokens" ? (
          <section aria-label="What leaves this instance" className="flex flex-col gap-1 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3">
            <span className="text-[13px] font-medium">What leaves this instance</span>
            <span className="text-[12px] leading-[1.5] text-muted-foreground">{whatLeaves(links, rows)}</span>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-zinc-300">Refused today · {data?.refusals.length ?? 0}</span>
            {(data?.refusals ?? []).slice(0, 3).map((f) => (
              <span key={`${f.ts}-${f.name}`}>
                {" · "}
                <span className="font-mono">{clockAt(Date.parse(f.ts), nowMs)}</span> {f.name} {f.reason}
              </span>
            ))}
          </span>
          <button type="button" className="truncate font-mono text-[12px] text-muted-foreground hover:text-foreground" onClick={() => props.onOpenHunt("service:toposcope status:refused")}>
            service:toposcope status:refused →
          </button>
        </div>
      </div>

      {inviting ? <InviteSheet onClose={() => setInviting(false)} onInvited={() => void loadPeople()} /> : null}
      {making && props.me ? (
        <MakeTokenSheet
          me={props.me}
          accounts={people?.service_accounts ?? []}
          isOwner={isOwner}
          onClose={() => setMaking(false)}
          onMade={() => {
            void loadPeople();
            void load();
          }}
        />
      ) : null}
      {door ? (
        <LetSomeoneIn
          initial={door === "link" ? "link" : null}
          onClose={() => setDoor(null)}
          onToken={() => void load()}
          onLink={(kind) => {
            setDoor(null);
            setMint(kind);
          }}
          onShare={() => {
            setDoor(null);
            props.onNewShare();
          }}
        />
      ) : null}
      <MintDialog kind={mint} here={props.here} onClose={() => setMint(null)} onMinted={() => void load()} />
      <PasteDialog open={paste} here={props.here} retentionDays={props.retentionDays} onClose={() => setPaste(false)} onLinked={() => void load()} />
    </main>
  );
}

/** The Links group's two ways in: make a key here (Let someone in, on Link) or paste one made elsewhere. */
export function LinkKeyButtons(props: { onMake: () => void; onPaste: () => void }) {
  return (
    <>
      <Button type="button" size="sm" variant="outline" className="h-[26px] text-[12px]" onClick={props.onMake}>
        Make a link key
      </Button>
      <Button type="button" size="sm" variant="outline" className="h-[26px] text-[12px]" onClick={props.onPaste}>
        Paste a link key
      </Button>
    </>
  );
}

/** "Let someone in" (26j): one door, three kinds, each saying what it lets through before it is made. Links' Make a link key opens it on Link. */
export function LetSomeoneIn(props: { initial?: "link" | null; onClose: () => void; onToken: () => void; onLink: (kind: "offer" | "invite") => void; onShare: () => void }) {
  const [kind, setKind] = useState<"token" | "link" | null>(props.initial ?? null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [way, setWay] = useState<"offer" | "invite">("offer");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  async function makeToken() {
    const res = await fetch("/api/api-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    if (!res.ok) {
      toast.error(`The token was not made (${res.status})`);
      return;
    }
    setSecret(((await res.json()) as { token: string }).token);
    props.onToken();
  }

  const card = (id: "token" | "link" | "share", glyph: string, color: string, title: string, sentence: string) => (
    <button
      type="button"
      aria-pressed={kind === id}
      className={cn("flex flex-col gap-2 rounded-[10px] border bg-[#131316] p-4 text-left", kind === id ? "border-plate" : "border-white/10 hover:border-zinc-500")}
      onClick={() => (id === "share" ? props.onShare() : setKind(id))}
    >
      <span className="inline-flex items-center gap-2 text-[14px] font-medium">
        <span style={{ color }}>{glyph}</span>
        {title}
      </span>
      <span className="text-[12px] leading-[1.5] text-muted-foreground">{sentence}</span>
    </button>
  );

  return (
    <>
    <div className="fixed inset-0 z-30 bg-black/55" aria-hidden="true" onClick={props.onClose} />
    <section aria-label="Let someone in" className="fixed top-[70px] left-1/2 z-40 flex w-[880px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-5 rounded-[12px] border border-zinc-700 bg-[#121214] px-7 py-6 shadow-[0_30px_80px_rgba(0,0,0,.7)]">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[17px] font-semibold">Let someone in</h2>
        <span className="text-[12.5px] text-muted-foreground">A token, a link or a share. Each says what it lets through before you make it.</span>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {card("token", "↓", "#60a5fa", "Token", "Sends logs here. An app, a collector or a hub writes logs, metrics, traces or marks with it. Nothing reads out.")}
        {card("link", "⇄", "#e7e1d3", "Link", "Copies rows between this instance and another Toposcope, either way, within a scope, ids included. Whoever copies from us sees everything the scope lets through.")}
        {card("share", "↑", "#2dd4bf", "Share", "Shows charts on another web page: counts and series, never a row. Usually made from a panel with Share…")}
      </div>
      {kind === "token" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void makeToken();
          }}
        >
          <label htmlFor="token-name" className="text-[12px] text-muted-foreground">
            Name · who sends with it
          </label>
          <input id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. boxes" className="h-[34px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[13px] outline-none" />
          {secret ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">Shown once · copy it now and send with Authorization: Bearer</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[7px] border border-dashed border-zinc-600 px-2.5 py-2 font-mono text-[12.5px]">{secret}</code>
                <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(secret)}>
                  Copy
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <Button type="submit" disabled={!name.trim()}>
                Make the token
              </Button>
              <span className="text-[12px] text-muted-foreground">It appears in Access under Tokens.</span>
            </div>
          )}
        </form>
      ) : kind === "link" ? (
        <div className="flex flex-col gap-3">
          <span className="text-[12px] text-muted-foreground">Which way</span>
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="inline-flex items-center gap-2">
              <input type="radio" checked={way === "offer"} onChange={() => setWay("offer")} />
              They copy from us · rows leave here
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" checked={way === "invite"} onChange={() => setWay("invite")} />
              We copy from them · rows come here
            </label>
          </div>
          <div className="flex items-center gap-2.5">
            <Button type="button" onClick={() => props.onLink(way)}>
              Choose the scope and make the key
            </Button>
            <span className="text-[12px] text-muted-foreground">The key is shown once; it appears under Links as key not used yet until the other side pastes it at Access › Paste a link key.</span>
          </div>
        </div>
      ) : null}
    </section>
    </>
  );
}
