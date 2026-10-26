import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AccessRefusal, AccessRow } from "../../access/list";
import { clockAt } from "../watch";
import { MintDialog, PasteDialog } from "./link-dialogs";

/**
 * Access (#265, frames 26i and 26j; the one door since 29a, #295): every way in or out of this
 * instance other than the operator password, grouped as Tokens, Links and Shares. Each row says its
 * kind in plain words, what it does, its scope, expiry, last use, today, and one action. "Let someone
 * in" is the one door to make another.
 */
export type AccessFilter = "all" | "tokens" | "links" | "shares";

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
  return filter === "all" || (filter === "tokens" ? row.kind === "token" : filter === "links" ? row.kind === "link" || row.kind === "invite" : row.kind === "share");
}

/** The three groups, in order, each with its one line (29a). */
export const accessGroups: Array<{ filter: Exclude<AccessFilter, "all">; title: string; words: string }> = [
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

export function AccessView(props: {
  filter: AccessFilter;
  onFilter: (filter: AccessFilter) => void;
  here: string | null;
  retentionDays: number;
  onOpenHunt: (q: string) => void;
  onOpenLink: (id: string) => void;
  onOpenShare: (name: string) => void;
  onNewShare: () => void;
}) {
  const [data, setData] = useState<{ rows: AccessRow[]; refusals: AccessRefusal[] } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [door, setDoor] = useState(false);
  const [mint, setMint] = useState<"offer" | "invite" | null>(null);
  const [paste, setPaste] = useState(false);
  const nowMs = Date.now();

  const load = useCallback(async () => {
    const res = await fetch("/api/access");
    if (res.ok) {
      setData((await res.json()) as { rows: AccessRow[]; refusals: AccessRefusal[] });
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
  const counts = {
    all: rows.length,
    tokens: rows.filter((r) => inFilter(r, "tokens")).length,
    links: rows.filter((r) => inFilter(r, "links")).length,
    shares: rows.filter((r) => inFilter(r, "shares")).length,
  };
  const refusedToday = rows.reduce((n, r) => n + r.today.refused, 0);
  const shown = rows.filter((r) => inFilter(r, props.filter));
  const col = "grid grid-cols-[150px_minmax(0,1.6fr)_minmax(0,1fr)_100px_160px_96px_72px] items-center gap-4";

  function row(r: AccessRow) {
    const exp = expiryWords(r, nowMs);
    const g = accessGlyph(r);
    return (
      <div key={`${r.kind}-${r.id}`} className={cn(col, "border-t border-white/[0.06] px-4 py-2.5 text-[12.5px]")}>
        <span className="inline-flex h-6 items-center gap-1.5 justify-self-start rounded-[6px] border border-white/10 px-2 text-[11.5px] whitespace-nowrap text-zinc-300">
          <span style={{ color: g.color }}>{g.glyph}</span>
          {r.verb}
        </span>
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{r.name}</span> <span className="text-muted-foreground">· {r.lets_through}</span>
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
            {(["all", "tokens", "links", "shares"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={props.filter === f}
                className={cn("h-[26px] rounded-[5px] px-2.5 text-[12px]", props.filter === f ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground")}
                onClick={() => props.onFilter(f)}
              >
                {f === "all" ? "All" : f === "tokens" ? "Tokens" : f === "links" ? "Links" : "Shares"} · {counts[f]}
              </button>
            ))}
          </span>
          <div className="flex-1" />
          <Button type="button" size="sm" onClick={() => setDoor(true)}>
            Let someone in
          </Button>
        </div>

        {data && rows.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Nothing here yet. Let someone in makes the first.</p> : null}
        {accessGroups
          .filter((g) => props.filter === "all" || props.filter === g.filter)
          .map((g) => {
            const groupRows = shown.filter((r) => inFilter(r, g.filter));
            if (props.filter === "all" && groupRows.length === 0 && g.filter !== "links") {
              return null;
            }
            return (
              <section key={g.filter} aria-label={g.title} className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
                <div className="flex flex-wrap items-center gap-2.5 px-4 py-2.5">
                  <h2 className="m-0 text-[13.5px] font-medium">{g.title}</h2>
                  <span className="text-[12px] text-muted-foreground">{g.words}</span>
                  <div className="flex-1" />
                  {g.filter === "links" ? (
                    <Button type="button" size="sm" variant="outline" className="h-[26px] text-[12px]" onClick={() => setPaste(true)}>
                      Paste a link key
                    </Button>
                  ) : null}
                </div>
                {groupRows.length === 0 ? <p className="px-4 py-2.5 text-[12.5px] text-muted-foreground">None yet.</p> : null}
                {groupRows.map((r) => row(r))}
              </section>
            );
          })}

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

      {door ? (
        <LetSomeoneIn
          onClose={() => setDoor(false)}
          onToken={() => void load()}
          onLink={(kind) => {
            setDoor(false);
            setMint(kind);
          }}
          onShare={() => {
            setDoor(false);
            props.onNewShare();
          }}
        />
      ) : null}
      <MintDialog kind={mint} here={props.here} onClose={() => setMint(null)} onMinted={() => void load()} />
      <PasteDialog open={paste} here={props.here} retentionDays={props.retentionDays} onClose={() => setPaste(false)} onLinked={() => void load()} />
    </main>
  );
}

/** "Let someone in" (26j): one door, three kinds, each saying what it lets through before it is made. */
function LetSomeoneIn(props: { onClose: () => void; onToken: () => void; onLink: (kind: "offer" | "invite") => void; onShare: () => void }) {
  const [kind, setKind] = useState<"token" | "link" | null>(null);
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
        <span className="text-[12.5px] text-muted-foreground">One door, three kinds. Each says what it lets through before you make it.</span>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {card("token", "↓", "#60a5fa", "Writes in", "An app, a collector or a hub sends logs, metrics, traces or marks. An ingest token. Nothing reads out.")}
        {card("link", "⇄", "#e7e1d3", "Copies rows out", "Another Toposcope pulls raw rows within a filter, ids included, and keeps its place. A link. The other operator sees everything the filter lets through.")}
        {card("share", "↑", "#2dd4bf", "Reads aggregates", "An app or a web page reads counts and series for its charts, never a row. A share. Usually made from a panel with Share…")}
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
              They pull from here · rows leave
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" checked={way === "invite"} onChange={() => setWay("invite")} />
              This instance pulls from them · rows arrive
            </label>
          </div>
          <div className="flex items-center gap-2.5">
            <Button type="button" onClick={() => props.onLink(way)}>
              Choose the scope and make the key
            </Button>
            <span className="text-[12px] text-muted-foreground">The key is shown once; it appears here as an invite until the other side pastes it.</span>
          </div>
        </div>
      ) : null}
    </section>
    </>
  );
}
