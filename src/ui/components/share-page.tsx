import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ShareView } from "../share-cover";
import { namedPanelTag, panelNameFor } from "../share-from-panel";
import { addablePanels, fenceLines, panelWords, type NamedPanel } from "../share-page";
import type { SavedSearch } from "../types";

/**
 * A share's page (#266, frame 26k): its named panels, the fence derived from them, the switch for
 * raw params, the tag that names a panel and the panel as the page sees it.
 */
export function SharePage(props: { name: string; onBack: () => void; onOpenHunt: (q: string) => void }) {
  const [share, setShare] = useState<ShareView | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [ticketCall, setTicketCall] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    const [res, res2] = await Promise.all([fetch("/api/shares"), fetch("/api/saved-searches")]);
    if (res.ok) {
      const json = (await res.json()) as { shares: ShareView[] };
      setShare(json.shares.find((s) => s.name === props.name && s.revoked_at === null) ?? null);
    }
    if (res2.ok) {
      setSaved(((await res2.json()) as { searches: SavedSearch[] }).searches);
    }
  }, [props.name]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const panels: NamedPanel[] = share?.panels ?? [];
  const shown = picked ?? panels[0]?.name ?? null;

  useEffect(() => {
    setPreview(null);
    if (!share || !shown) {
      return;
    }
    void fetch(`/api/shares/${encodeURIComponent(share.name)}/ticket`, { method: "POST" })
      .then((res) => (res.ok ? (res.json() as Promise<{ ticket?: string }>) : null))
      .then((json) => json?.ticket && setPreview(`/embed?${new URLSearchParams({ ticket: json.ticket, panel: shown, theme: "dark" })}`))
      .catch(() => undefined);
  }, [share, shown]);

  /** Every panel on a saved hunt or board that a share can hold, as an option to add. */
  const { options: addable, why: nothingToAdd } = useMemo(() => addablePanels(saved, share?.scope.logs ?? null), [saved, share]);

  async function put(body: Record<string, unknown>, ok: string) {
    if (!share) {
      return;
    }
    const res = await fetch(`/api/shares/${encodeURIComponent(share.name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expires_at: share.expires_at, limits: share.limits, embed: share.embed, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(json.error ?? `Save failed (${res.status})`);
      return;
    }
    toast.success(ok);
    await load();
  }

  async function addPanel(id: string) {
    const opt = addable.find((a) => a.id === id);
    if (!opt || !share) {
      return;
    }
    const name = panelNameFor(opt.panel.name, panels.map((p) => p.name));
    // The fence follows the panels: no scope is sent, so the server derives it and says when it widens.
    await put({ panels: [...panels, { ...opt.panel, name }], logs: share.scope.logs ?? opt.logs ?? undefined }, `${name} added; the fence follows it`);
    setPicked(name);
  }

  async function revoke() {
    if (!share) {
      return;
    }
    const res = await fetch(`/api/shares/${encodeURIComponent(share.name)}`, { method: "DELETE" });
    if (res.ok) {
      toast.success(`${share.name} revoked`);
      props.onBack();
    } else {
      toast.error(`Revoke failed (${res.status})`);
    }
  }

  if (!share) {
    return <main className="p-6 text-[13px] text-muted-foreground">{share === null ? "Loading the share…" : ""}</main>;
  }
  const days = Math.max(0, Math.round((share.expires_at - Date.now()) / 86_400_000));
  const rawOn = share.raw_params !== false;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3 text-[13px]">
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={props.onBack}>
          Access
        </button>
        <span className="text-zinc-600">›</span>
        <span className="font-medium text-foreground">{share.name}</span>
        <span className="ml-1.5 text-[12px] text-muted-foreground">
          <span className="text-teal-400">↑</span> share · {panels.length} panel{panels.length === 1 ? "" : "s"} · expires in {days} d
        </span>
        <div className="flex-1" />
        {nothingToAdd ? <span className="text-[12px] text-muted-foreground">{nothingToAdd}</span> : null}
        <select
          aria-label="Add a panel"
          value=""
          disabled={addable.length === 0}
          title={nothingToAdd ?? "A panel from a saved hunt or board, kept on this share under a name"}
          onChange={(e) => void addPanel(e.target.value)}
          className="h-8 max-w-[300px] rounded-[7px] border border-white/10 bg-[#141416] px-2 text-[12.5px] disabled:opacity-50"
        >
          <option value="">Add a panel…</option>
          {addable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="outline" onClick={() => setTicketCall((v) => !v)}>
          New ticket call
        </Button>
        {armed === "revoke" ? (
          <Button type="button" size="sm" variant="outline" className="text-red-300" onClick={() => void revoke()}>
            Sure? Revoke
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" className="text-red-300" onClick={() => setArmed("revoke")}>
            Revoke
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 px-6 pt-4 pb-6 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-h-0 flex-col gap-3.5">
          <section className="flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-muted-foreground">Panels · designed here, named for the page</span>
              <span className="text-[12px] text-muted-foreground">a page names one; edit here and every page follows</span>
            </div>
            {panels.length === 0 ? <p className="m-0 text-[12.5px] text-muted-foreground">No named panels yet. Add one from a saved hunt or a board, or use Share… on a panel.</p> : null}
            {panels.map((p) => (
              <div key={p.name} className={cn("grid grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-3 rounded-[7px] px-2 py-1.5 text-[12.5px]", p.name === shown && "bg-white/[0.04]")}>
                <button type="button" className="truncate text-left font-mono text-plate" onClick={() => setPicked(p.name)}>
                  {p.name}
                </button>
                <span className="truncate">
                  {panelWords(p)}
                  {p.from ? <span className="text-muted-foreground"> · from {p.from}</span> : null}
                </span>
                {armed === `rm:${p.name}` ? (
                  <button type="button" className="text-[12px] text-red-300" onClick={() => void put({ panels: panels.filter((x) => x.name !== p.name), logs: share.scope.logs ?? undefined }, `${p.name} removed`)}>
                    sure? remove
                  </button>
                ) : (
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(`rm:${p.name}`)}>
                    remove
                  </button>
                )}
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-muted-foreground">The fence · {panels.length ? "derived from the panels" : "as written"}</span>
              <label className="inline-flex items-center gap-2 text-[12.5px]">
                <Switch checked={rawOn} onCheckedChange={(on) => void put({ raw_params: on }, on ? "Raw params allowed within the fence" : "Pages may only name a panel now")} />
                Also allow raw params within it
              </label>
            </div>
            <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
              {fenceLines(share).map(([k, v]) => (
                <span key={k} className="contents">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="truncate font-mono">{v}</span>
                </span>
              ))}
            </div>
            <span className="text-[12px] text-muted-foreground">
              Adding a panel that needs more widens the fence. With the switch off, a tag may only name a panel and move its window.
            </span>
          </section>
        </div>
        <div className="flex min-h-0 flex-col gap-3.5">
          {ticketCall ? (
            <section className="flex flex-col gap-2 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5">
              <span className="text-[12px] text-muted-foreground">The host's backend asks for a ticket per page load</span>
              <pre className="m-0 overflow-x-auto rounded-[7px] border border-white/10 bg-[#0d0d0f] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">{`curl -X POST ${origin}/share/v1/tickets \\\n  -H "Authorization: Bearer $TOPOSCOPE_SHARE"`}</pre>
            </section>
          ) : null}
          <section className="flex flex-col gap-2 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5">
            <span className="text-[12px] text-muted-foreground">The tag, now</span>
            <pre className="m-0 overflow-x-auto rounded-[7px] border border-white/10 bg-[#0d0d0f] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">{shown ? namedPanelTag(origin, shown) : "Add a panel first."}</pre>
            <span className="text-[12px] text-muted-foreground">One line names the panel. Title, kind, range and split come from here; a page may pass data-range to move the window within the limits.</span>
          </section>
          <section className="flex min-h-[220px] flex-1 flex-col gap-2 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] text-muted-foreground">{shown ? `${shown} · as the page sees it` : "Preview"}</span>
              <span className="text-[12px] text-muted-foreground">preview through this share</span>
            </div>
            {preview ? <iframe title="Panel preview" src={preview} className="min-h-[180px] w-full flex-1 rounded-[8px] border border-white/10 bg-[#0d0d0f]" /> : <div className="flex-1 rounded-[8px] border border-white/10 bg-[#0d0d0f]" />}
            <button type="button" className="self-start text-[12px] text-muted-foreground hover:text-foreground" onClick={() => props.onOpenHunt(`service:toposcope access:${share.name}`)}>
              {share.use ? `${share.use.reads_24h.toLocaleString("en-US")} reads in 24 h` : "its use"} →
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}
