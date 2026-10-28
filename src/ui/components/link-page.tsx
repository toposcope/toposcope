import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { behindLagWords, behindWords, furtherWords, kindLineWords, kindsCarried, linkKind, linkTitle, quarterBars, ratePerHour, type LinkPageData } from "../link-page";
import { bytesDay, kindTitle, type LinkKind } from "../link-kinds";
import { formatCompactCount } from "../count-format";
import { KindBoxes } from "./kind-boxes";
import { clockAt } from "../watch";

/**
 * A link's page (#267, frame 26m), from its Access row: which way rows move, the scope, where it
 * stands, the rows it pulled over a day with any gap drawn as a floor, pause and revoke. The key is
 * never shown again.
 */
export function LinkPage(props: { id: string; onBack: () => void; onOpenHunt: (q: string) => void }) {
  const [link, setLink] = useState<LinkPageData | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editKinds, setEditKinds] = useState<LinkKind[]>([]);
  const [armed, setArmed] = useState(false);
  const nowMs = Date.now();

  const load = useCallback(async () => {
    const res = await fetch(`/api/links/${encodeURIComponent(props.id)}`);
    if (res.status === 404) {
      setMissing(true);
      return;
    }
    if (res.ok) {
      setLink((await res.json()) as LinkPageData);
    }
  }, [props.id]);
  useEffect(() => {
    void load().catch(() => undefined);
    const t = setInterval(() => void load().catch(() => undefined), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function put(body: Record<string, unknown>, ok: string) {
    const res = await fetch(`/api/links/${encodeURIComponent(props.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & Partial<LinkPageData>;
    if (!res.ok) {
      toast.error(json.error ?? `Save failed (${res.status})`);
      return false;
    }
    setLink(json as LinkPageData);
    toast.success(ok);
    return true;
  }

  async function revoke() {
    const res = await fetch(`/api/links/${encodeURIComponent(props.id)}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Link removed");
      props.onBack();
    } else {
      toast.error(`Revoke failed (${res.status})`);
    }
  }

  if (missing) {
    return <main className="p-6 text-[13px] text-muted-foreground">This link is gone. <button type="button" className="text-zinc-300" onClick={props.onBack}>Back to Access</button></main>;
  }
  if (!link) {
    return <main className="p-6 text-[13px] text-muted-foreground">Loading the link…</main>;
  }
  const behind = behindWords(link);
  const lag = behindLagWords(link);
  const further = link.further ?? [];
  const bars = quarterBars(link.pulled, link.holes, nowMs);
  const peak = Math.max(1, ...bars.map((b) => b.n));
  const card = "flex flex-col gap-2 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5";
  const kv = "grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]";
  const lines = link.kinds ?? [];
  const { carries, unticked } = kindsCarried(lines);
  // Where rows leave here, Change scope also unticks kinds (#329); a kind is never added back.
  const kindsHere = link.role === "serve" && lines.length > 0;
  const source = link.role === "pull" ? link.peer : "here";
  function startEditing() {
    if (editing !== null) {
      setEditing(null);
      return;
    }
    setEditing(link!.q);
    setEditKinds(carries);
  }
  function save(q: string) {
    const body: Record<string, unknown> = { q };
    if (kindsHere && editKinds.join(",") !== carries.join(",")) {
      body.kinds = editKinds;
    }
    void put(body, body.kinds ? "Scope and kinds changed: the next pull reads them" : "Scope changed: the next pull reads it").then((ok) => ok && setEditing(null));
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3 text-[13px]">
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onBack}>
          Access
        </button>
        <span className="text-zinc-600">›</span>
        <span className="font-medium text-foreground">{linkTitle(link)}</span>
        <span className="ml-1 inline-flex h-[22px] items-center gap-1.5 rounded-[6px] border border-white/10 px-2 text-[11.5px] whitespace-nowrap text-zinc-300">
          <span className="text-plate">{linkKind(link).glyph}</span>
          {linkKind(link).words}
        </span>
        <span className="ml-1.5 text-[12px] text-muted-foreground">
          {link.role === "pull" ? `this instance pulls ${link.peer}'s rows` : `${link.peer} pulls our rows`} · since {new Date(link.created_at).toISOString().slice(0, 10)}
        </span>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="outline" onClick={() => void put({ paused: !link.paused }, link.paused ? "Resumed" : "Paused: the link stays and keeps its place")}>
          {link.paused ? "Resume" : link.role === "pull" ? "Pause pulling" : "Pause serving"}
        </Button>
        {link.scope_here || kindsHere ? (
          <Button type="button" size="sm" variant="outline" onClick={startEditing}>
            Change scope
          </Button>
        ) : null}
        {armed ? (
          <Button type="button" size="sm" variant="outline" className="text-red-300" onClick={() => void revoke()}>
            Sure? Revoke
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" className="text-red-300" onClick={() => setArmed(true)}>
            Revoke
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 px-6 pt-4 pb-6 lg:grid-cols-[420px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3.5">
          <section className={card}>
            <span className="text-[12px] text-muted-foreground">Which way, and what</span>
            <div className={kv}>
              <span className="text-muted-foreground">from</span>
              <span className="truncate font-mono">{link.role === "pull" ? `${link.peer} · ${link.peer_url}` : "here"}</span>
              <span className="text-muted-foreground">pulled by</span>
              <span className="truncate font-mono">{link.role === "pull" ? "this instance" : link.peer}</span>
              <span className="text-muted-foreground">scope</span>
              {editing !== null ? (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save(link.scope_here ? editing : link.q);
                  }}
                >
                  <div className="flex gap-1.5">
                    {link.scope_here ? (
                      <input aria-label="Scope" value={editing} onChange={(e) => setEditing(e.target.value)} className="h-7 min-w-0 flex-1 rounded-[6px] border border-white/10 bg-[#0d0d0f] px-2 font-mono text-[12px] outline-none" />
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-mono">{link.q || "every row"}</span>
                    )}
                    <Button type="submit" size="sm" disabled={kindsHere && editKinds.length === 0}>
                      Save
                    </Button>
                  </div>
                  {kindsHere ? (
                    <>
                      <KindBoxes q={link.scope_here ? editing : link.q} ticked={editKinds} onChange={setEditKinds} legend="What leaves" allowed={carries} />
                      <span className="text-[11.5px] text-muted-foreground">Unticking keeps the link and its place. A kind is never added to a key already used: to send one too, make a new key.</span>
                    </>
                  ) : null}
                </form>
              ) : (
                <span className="truncate font-mono">{link.q || "every row"}</span>
              )}
              {lines.length > 0 ? (
                <>
                  <span className="text-muted-foreground">kinds</span>
                  <span className="text-zinc-300">{carries.join(" · ") || "none"}</span>
                  {unticked.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">unticked</span>
                      <span className="text-muted-foreground">
                        {unticked.join(", ")}, at the source{link.role === "pull" ? ` (${link.peer})` : ""}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
              <span className="text-muted-foreground">rows carry</span>
              <span className="text-muted-foreground">everything the scope lets through, ids included; stamped <span className="font-mono text-zinc-300">toposcope:{link.role === "pull" ? link.peer : "here"}</span></span>
              <span className="text-muted-foreground">key</span>
              <span className="text-muted-foreground">never shown again · revoke to end it</span>
            </div>
            {!link.scope_here ? <span className="text-[12px] text-muted-foreground">The other instance holds this link's scope: change it there.</span> : null}
          </section>
          {link.role === "pull" ? (
            <section className={card}>
              <span className="text-[12px] text-muted-foreground">Where its rows show</span>
              <span className="text-[12px] leading-[1.5] text-muted-foreground">
                On every hunt that matches them, and as a <span className="font-mono text-zinc-300">from {link.peer}</span> chip in the slice. A gap in pulling is drawn as a floor under the bars, so a quiet hour is never mistaken for a lost one.
              </span>
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => props.onOpenHunt(`toposcope:${link.peer}`)}>
                Open as a hunt · toposcope:{link.peer}
              </Button>
            </section>
          ) : null}
          <section className={card}>
            <span className="text-[12px] text-muted-foreground">Where it stands</span>
            {link.last_error ? <span className="text-[12px] text-amber-300">last call failed: {link.last_error}</span> : null}
            {link.holes.map((h) => (
              <span key={h.from} className="text-[12px] text-amber-300">
                a gap from {h.from.slice(0, 16).replace("T", " ")} to {h.to.slice(0, 16).replace("T", " ")} · drawn as a floor
              </span>
            ))}
            {further.length > 0 ? (
              <div aria-label="Further away" className="flex flex-col gap-1 border-t border-white/[0.06] pt-2">
                <span className="text-[12px] text-muted-foreground">
                  {link.role === "pull" ? `Further away, through ${link.peer}` : `Further away, told to ${link.peer}`}
                </span>
                {further.map((f) => {
                  const w = furtherWords(f, nowMs);
                  return (
                    <span key={f.name} className="flex items-baseline gap-2 text-[12px]">
                      <span className={cn("inline-block size-[7px] shrink-0 rounded-full", w.ok ? "bg-emerald-300" : "bg-amber-400")} aria-hidden="true" />
                      <span className="font-mono text-zinc-300">{f.name}</span>
                      <span className={w.ok ? "text-muted-foreground" : "text-amber-300"}>{w.text}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}
            <span className="text-[12px] text-muted-foreground">Made {new Date(link.created_at).toISOString().slice(0, 16).replace("T", " ")} · key pasted then</span>
          </section>
        </div>
        <div className="flex min-h-0 flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
            <section className={card}>
              <span className="text-[12px] text-muted-foreground">Position</span>
              <span className="font-mono text-[20px] font-semibold">{link.position.toLocaleString("en-US")}</span>
              <span className="text-[12px] text-muted-foreground">sequence {link.role === "pull" ? "pulled" : "they read to"}</span>
            </section>
            <section className={card}>
              <span className="text-[12px] text-muted-foreground">Behind</span>
              <span className={cn("font-mono text-[20px] font-semibold", !behind.ok && "text-amber-300")}>{behind.text}</span>
              <span className={cn("text-[12px]", lag ? "text-amber-300" : "text-muted-foreground")}>
                {link.arrived_at ? `read to ${link.arrived_at.slice(11, 19)}` : "—"}
                {lag ? ` · ${lag}` : ""}
              </span>
            </section>
            <section className={card}>
              <span className="text-[12px] text-muted-foreground">Last {link.role === "pull" ? "pull" : "read"}</span>
              <span className="font-mono text-[20px] font-semibold">{link.last_contact_at ? new Date(link.last_contact_at).toISOString().slice(11, 19) : "never"}</span>
              <span className="text-[12px] text-muted-foreground">{link.last_contact_at ? clockAt(link.last_contact_at, nowMs) : ""}</span>
            </section>
            <section className={card}>
              <span className="text-[12px] text-muted-foreground">Rate</span>
              <span className="font-mono text-[20px] font-semibold">{link.role === "pull" ? ratePerHour(link.pulled_24h) : "—"}</span>
              <span className="text-[12px] text-muted-foreground">{link.role === "pull" ? `last 24 h · ${link.pulled_24h.toLocaleString("en-US")} rows` : "counted at the puller"}</span>
            </section>
          </div>
          {lines.length > 0 ? (
            <section aria-label="By kind" className="shrink-0 overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
              <div className="flex items-baseline gap-2.5 border-b border-white/[0.06] px-4 py-3">
                <span className="text-[13.5px] font-medium text-foreground">By kind</span>
                <span className="text-[12px] text-muted-foreground">what this link carries, each on the one position above</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[11px] tracking-[0.04em] text-muted-foreground uppercase">
                      <th className="px-4 py-2 font-normal">Kind</th>
                      <th className="px-2 py-2 font-normal">State</th>
                      <th className="px-2 py-2 font-normal">Note</th>
                      <th className="px-2 py-2 text-right font-normal">Rows / day</th>
                      <th className="px-4 py-2 text-right font-normal">Bytes / day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((k) => {
                      const w = kindLineWords(k, link);
                      const off = w.tone === "off";
                      return (
                        <tr key={k.kind} className={cn("border-t border-white/[0.06]", !k.ticked && "opacity-70")}>
                          <td className={cn("px-4 py-2.5 font-medium", off ? "text-zinc-400" : "text-foreground")}>{kindTitle[k.kind]}</td>
                          <td className={cn("px-2 py-2.5 whitespace-nowrap", off && "text-muted-foreground")}>
                            <span
                              aria-hidden="true"
                              className={cn("mr-2 inline-block size-[7px] rounded-full align-[1px]", w.tone === "ok" ? "bg-emerald-300" : w.tone === "warn" ? "bg-amber-400" : "bg-zinc-700")}
                            />
                            {w.state}
                          </td>
                          <td className={cn("px-2 py-2.5 text-[12px]", k.state === "a hole" ? "text-amber-400" : "text-muted-foreground")}>{w.note}</td>
                          <td className={cn("px-2 py-2.5 text-right font-mono", off && "text-muted-foreground")}>{k.ticked ? formatCompactCount(k.rows_day) : "—"}</td>
                          <td className={cn("px-4 py-2.5 text-right font-mono", off && "text-muted-foreground")}>{k.ticked ? bytesDay(k.bytes_day) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {lines.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">
              Rows and bytes per day show on both sides, so the side rows leave from ({source}) can untick a kind that costs too much. Unticking keeps the link and its place. A kind is never added to a key already used.
            </span>
          ) : null}
          {link.role === "pull" ? (
            <section className={cn(card, "min-h-[260px] flex-1")}>
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-muted-foreground">Rows pulled · last 24 h · gaps as floors</span>
                <span className="text-[12px] text-muted-foreground">{link.holes.length ? `${link.holes.length} gap` : "no gap"}</span>
              </div>
              <div className="relative flex min-h-[200px] flex-1 items-end gap-0.5 border-b border-white/10">
                {bars.map((b) => (
                  <div
                    key={b.t}
                    title={`${new Date(b.t).toISOString().slice(11, 16)} · ${b.n} rows${b.gap ? " · gap" : ""}`}
                    className="min-w-0 flex-1"
                    style={{
                      height: b.gap ? "100%" : `${Math.max(1, Math.round((b.n / peak) * 200))}px`,
                      background: b.gap ? "repeating-linear-gradient(135deg,rgba(251,191,36,.18) 0 4px,transparent 4px 9px)" : "#2f6fa3",
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground">
                <span>24 h ago</span>
                <span>now</span>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
