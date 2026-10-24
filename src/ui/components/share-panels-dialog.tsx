import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogControl,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shareIsLive, type ShareView } from "@/share-cover";
import {
  likePattern,
  mergeScope,
  panelEmbedQuery,
  panelRead,
  panelTag,
  proposeScope,
  proposedShareName,
  type PanelRead,
  type ProposalChoices,
  type ProposedScope,
} from "@/share-from-panel";
import { announceShares, useShares } from "@/use-shares";
import type { WidgetDef } from "../../shared/widgets";

export type SharePanel = { widget: WidgetDef; title: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panels on the canvas; one when opened from a panel (24a), all when from Share panels… (24g). */
  panels: SharePanel[];
  /** Which are ticked when it opens. */
  picked: string[];
  /** The hunt's `q`: what a log panel counts. */
  query: string;
  /** The window as a range token (`24h`), for the tags. */
  range: string;
};

type Done = { share: string; secret: string | null; added: string[]; reads: PanelRead[] };

const section = "pt-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const codeBox =
  "m-0 overflow-x-auto rounded-[4.4px] border border-white/12 bg-background px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre text-zinc-300";
const yearOut = () => new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error("Copy failed"),
  );
}

/** Share… from a panel or a board (#236, frames 24b–24g). */
export function SharePanelsDialog({ open, onOpenChange, panels, picked, query, range }: Props) {
  const shares = useShares();
  const live = shares.filter((s) => shareIsLive(s));
  const [ticked, setTicked] = useState<string[]>(picked);
  const [offers, setOffers] = useState<Record<string, PanelRead[]>>({});
  const [choices, setChoices] = useState<ProposalChoices>({ allLike: false, splitOn: true, narrowOn: false, logsOn: false });
  const [into, setInto] = useState<string>("");
  const [step, setStep] = useState<"scope" | "new" | "done">("scope");
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [until, setUntil] = useState(yearOut());
  const [done, setDone] = useState<Done | null>(null);
  const [likeCount, setLikeCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTicked(picked);
      setOffers({});
      setStep("scope");
      setDone(null);
      setPreview(null);
      setInto("");
      setUntil(yearOut());
    }
  }, [open, picked]);

  const readsBy = useMemo(() => new Map(panels.map((p) => [p.widget.id, panelRead(p.widget)])), [panels]);
  const reads: PanelRead[] = ticked.flatMap((id) => {
    const r = readsBy.get(id);
    return !r ? [] : "reads" in r ? r.reads : (offers[id] ?? []);
  });
  const refusedTicked = ticked.filter((id) => {
    const r = readsBy.get(id);
    return r && !("reads" in r) && !offers[id];
  });
  const { scope, dropped } = proposeScope(reads, query, choices);
  const metricNames = reads.filter((r) => r.kind === "metric").map((r) => (r as { name: string }).name);
  const like = metricNames.length > 0 ? likePattern(metricNames[0]!) : null;
  const splitKey = scope.split[0] ?? reads.map((r) => (r.kind === "metric" ? r.split : r.kind === "logs" ? r.split : r.key)).find(Boolean) ?? null;
  const service = /(?:^|,)service:([^,]+)/.exec(scope.metric_labels)?.[1] ?? null;

  useEffect(() => {
    if (!open || !like) return;
    void fetch("/api/metric-names?range=24h")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { keys?: Array<{ k: string }> } | null) =>
        setLikeCount(json?.keys?.filter((k) => k.k.startsWith(like.slice(0, -1))).length ?? null),
      )
      .catch(() => setLikeCount(null));
  }, [open, like]);

  useEffect(() => {
    if (step !== "done" || !done || done.reads.length === 0) return;
    void fetch(`/api/shares/${encodeURIComponent(done.share)}/ticket`, { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { ticket?: string } | null) => {
        if (json?.ticket) {
          const q = panelEmbedQuery(done.reads[0]!, range);
          q.set("ticket", json.ticket);
          setPreview(`/embed?${q.toString()}`);
        }
      })
      .catch(() => setPreview(null));
  }, [step, done, range]);

  async function reload(): Promise<ShareView[]> {
    const res = await fetch("/api/shares");
    const json = res.ok ? ((await res.json()) as { shares: ShareView[] }) : { shares: [] };
    announceShares(json.shares);
    return json.shares;
  }

  async function addToExisting() {
    const share = live.find((s) => s.name === into);
    if (!share) return;
    const merged = mergeScope(share, scope);
    if ("why" in merged) {
      toast.error(merged.why);
      return;
    }
    const res = await fetch(`/api/shares/${encodeURIComponent(share.name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expires_at: share.expires_at, scope: merged.scope, limits: share.limits, embed: share.embed }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(json.error ?? `Save failed (${res.status})`);
      return;
    }
    await reload();
    setDone({ share: share.name, secret: null, added: merged.added, reads });
    setStep("done");
  }

  async function createNew() {
    const res = await fetch("/api/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim().toLowerCase(),
        expires_at: until,
        scope,
        embed: { frame_ancestors: site.trim() ? [site.trim().replace(/\/$/, "")] : [] },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; secret?: string };
    if (!res.ok) {
      toast.error(json.error ?? `Create failed (${res.status})`);
      return;
    }
    await reload();
    setDone({ share: name.trim().toLowerCase(), secret: json.secret ?? null, added: [], reads });
    setStep("done");
  }

  const origin = window.location.origin;
  const wide = step === "done" ? "max-w-[900px]" : "max-w-[640px]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide}>
        {step === "scope" ? (
          <>
            <DialogHeader>
              <DialogTitle>{panels.length > 1 && picked.length !== 1 ? "Share panels" : "Share this panel"}</DialogTitle>
              <DialogDescription>Another site will see these numbers, and nothing else: series and counts, never log lines.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3.5">
              {panels.length > 1 && picked.length !== 1 ? (
                <div className="flex flex-col rounded-[6.4px] border border-white/10">
                  {panels.map((p) => {
                    const r = readsBy.get(p.widget.id)!;
                    const off = !("reads" in r) && r.offers.length === 0;
                    return (
                      <label key={p.widget.id} className={`flex items-center gap-2.5 border-b border-white/[0.08] px-3 py-2 text-[13px] last:border-b-0 ${off ? "text-muted-foreground/60" : ""}`}>
                        <input
                          type="checkbox"
                          disabled={off}
                          checked={ticked.includes(p.widget.id)}
                          onChange={(e) =>
                            setTicked((prev) => (e.target.checked ? [...prev, p.widget.id] : prev.filter((id) => id !== p.widget.id)))
                          }
                          className="accent-[var(--color-plate)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                          {"reads" in r ? readWords(r.reads[0]!) : r.offers.length ? "share one part" : r.why}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {refusedTicked.map((id) => {
                const r = readsBy.get(id)!;
                if ("reads" in r) return null;
                return (
                  <div key={id} className="flex flex-col gap-2 rounded-[6.4px] border border-white/12 p-3">
                    <span className="text-[13px] leading-[1.5] text-zinc-300">{r.why}</span>
                    <div className="flex flex-wrap gap-2">
                      {r.offers.map((o) => (
                        <button
                          key={o.label}
                          type="button"
                          className="h-[30px] rounded-[4.4px] border border-input px-2.5 text-[12.5px] hover:bg-accent"
                          onClick={() => setOffers((prev) => ({ ...prev, [id]: o.reads }))}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {reads.length > 0 ? (
                <>
                  <div className={section}>What it can read</div>
                  <div className="flex flex-col rounded-[6.4px] border border-white/10">
                    {metricNames.length > 0 ? (
                      <div className="flex flex-col gap-2 border-b border-white/[0.08] px-3 py-2.5 last:border-b-0">
                        <span className="text-[13px] font-medium">Metrics</span>
                        <label className="flex items-center gap-2 text-[13px]">
                          <input type="radio" name="like" checked={!choices.allLike} onChange={() => setChoices((c) => ({ ...c, allLike: false }))} className="accent-[var(--color-plate)]" />
                          {metricNames.length === 1 ? "Only this one" : `Only these ${new Set(metricNames).size}`}
                          <span className="truncate font-mono text-[12px] text-muted-foreground">{[...new Set(metricNames)].join(" ")}</span>
                        </label>
                        {like ? (
                          <label className="flex items-center gap-2 text-[13px]">
                            <input type="radio" name="like" checked={choices.allLike} onChange={() => setChoices((c) => ({ ...c, allLike: true }))} className="accent-[var(--color-plate)]" />
                            {likeCount !== null ? `All ${likeCount} like it` : "All like it"}
                            <span className="font-mono text-[12px] text-muted-foreground">{like}</span>
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    {scope.metric_labels || scope.logs ? (
                      <div className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 last:border-b-0">
                        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="font-mono text-[12.5px]">{scope.metric_labels || scope.logs}</span>
                        <span className="text-[12px] text-muted-foreground">fixed from the panel · the site cannot read others</span>
                      </div>
                    ) : null}
                    {dropped.length > 0 ? (
                      <div className="border-b border-white/[0.08] px-3 py-2 text-[12px] text-amber-400 last:border-b-0">
                        The panels disagree on {dropped.join(", ")}: it is not fixed, so the share reads every value of it.
                      </div>
                    ) : null}
                    {splitKey ? (
                      <label className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 text-[13px] last:border-b-0">
                        <input type="checkbox" checked={choices.splitOn || reads.some((r) => r.kind === "top")} disabled={reads.some((r) => r.kind === "top")} onChange={(e) => setChoices((c) => ({ ...c, splitOn: e.target.checked }))} className="accent-[var(--color-plate)]" />
                        One line per {splitKey}
                        <span className="text-[12px] text-muted-foreground">its values are shown</span>
                      </label>
                    ) : null}
                    {splitKey ? (
                      <label className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 text-[13px] last:border-b-0">
                        <input type="checkbox" checked={choices.narrowOn} onChange={(e) => setChoices((c) => ({ ...c, narrowOn: e.target.checked }))} className="accent-[var(--color-plate)]" />
                        Let a panel pick one {splitKey}
                        <span className="text-[12px] text-muted-foreground">for a page per {splitKey}</span>
                      </label>
                    ) : null}
                    {service && !reads.some((r) => r.kind !== "metric") ? (
                      <label className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
                        <input type="checkbox" checked={choices.logsOn} onChange={(e) => setChoices((c) => ({ ...c, logsOn: e.target.checked }))} className="accent-[var(--color-plate)]" />
                        Also count {service}'s log lines
                        <span className="text-[12px] text-muted-foreground">how many, how fast · never the lines</span>
                      </label>
                    ) : null}
                  </div>
                  <div className={section}>Into</div>
                  <select
                    aria-label="Into"
                    value={into}
                    onChange={(e) => setInto(e.target.value)}
                    className="h-8 rounded-[4.4px] border border-input bg-transparent px-2 text-[13px]"
                  >
                    <option value="">A new share</option>
                    {live.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <div className="font-mono text-[11.5px] text-muted-foreground">bars ≥1m · 7-day windows · 30 days back · 120 reads/min · change in Settings → Shares</div>
                </>
              ) : null}
            </div>
            <DialogFooter className="justify-end">
              <button type="button" className="h-8 rounded-[4.4px] border border-input px-3 text-[13px] hover:bg-accent" onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <Button
                type="button"
                className="h-8 bg-plate text-[#18181b] hover:bg-plate/90"
                disabled={reads.length === 0}
                onClick={() => {
                  if (into) {
                    void addToExisting();
                  } else {
                    setName(proposedShareName(scope, shares.map((s) => s.name)));
                    setStep("new");
                  }
                }}
              >
                {into ? `Add to ${into}` : "Next"}
              </Button>
            </DialogFooter>
          </>
        ) : step === "new" ? (
          <>
            <DialogHeader>
              <DialogTitle>Share this panel</DialogTitle>
              <DialogDescription className="font-mono text-[12px]">{scopeWords(scope)}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3.5">
              <div className={section}>A new share</div>
              <DialogField label="Name" help="Proposed from the service. It names the share in its use rows.">
                <DialogControl>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
                </DialogControl>
              </DialogField>
              <DialogField label="Shown on" help="The site that will put the panel in a page. Only it can frame it.">
                <DialogControl className="border-plate/50">
                  <input value={site} placeholder="https://admin.example.com" onChange={(e) => setSite(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
                </DialogControl>
              </DialogField>
              <DialogField label="Works until">
                <DialogControl>
                  <input value={until} onChange={(e) => setUntil(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
                  <span className="shrink-0 text-[11px] text-muted-foreground">a year · revoke any time</span>
                </DialogControl>
              </DialogField>
              <div className="font-mono text-[11.5px] text-muted-foreground">bars ≥1m · 7-day windows · 30 days back · 120 reads/min</div>
            </div>
            <DialogFooter className="justify-end">
              <button type="button" className="h-8 rounded-[4.4px] border border-input px-3 text-[13px] hover:bg-accent" onClick={() => setStep("scope")}>
                Back
              </button>
              <Button type="button" className="h-8 bg-plate text-[#18181b] hover:bg-plate/90" disabled={!name.trim()} onClick={() => void createNew()}>
                Create and get the code
              </Button>
            </DialogFooter>
          </>
        ) : done ? (
          <>
            <DialogHeader>
              <DialogTitle>{done.secret ? `${done.share} is ready` : `Added to ${done.share}`}</DialogTitle>
              <DialogDescription>
                {done.secret ? "Three things to paste. The secret is shown this once." : "Its secret is already on your backend, and step 2 is already done there."}
              </DialogDescription>
            </DialogHeader>
            {!done.secret && done.added.length > 0 ? (
              <div className="mb-3 rounded-[6.4px] border border-amber-400/40 bg-amber-400/[0.06] px-2.5 py-2 text-[12.5px]">
                <span className="text-amber-400">{done.share} now also reads</span> <span className="font-mono">{done.added.join(" · ")}</span>
              </div>
            ) : null}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
              <div className="flex min-w-0 flex-col gap-3.5">
                {done.secret ? (
                  <Step n="1" title="The secret, on your backend" onCopy={() => copy(`TOPOSCOPE_SHARE=${done.secret}`, "Secret")}>
                    <div className="truncate rounded-[4.4px] border border-plate/50 px-2.5 py-1.5 font-mono text-[12.5px]">TOPOSCOPE_SHARE={done.secret}</div>
                    <span className="text-[11px] text-muted-foreground">An environment variable of the app that serves the page. Never in the page.</span>
                  </Step>
                ) : null}
                {done.secret ? (
                  <Step n="2" title="Each page load, your backend asks for a ticket" onCopy={() => copy(ticketCall(origin), "Ticket call")}>
                    <pre className={codeBox}>{ticketCall(origin)}</pre>
                    <span className="text-[11px] text-muted-foreground">A ticket lasts an hour and can only read. Hand it to the page.</span>
                  </Step>
                ) : null}
                {!done.secret ? (
                  <div className="flex items-baseline gap-2 opacity-55">
                    <span className="font-mono text-[12px]">1–2</span>
                    <span className="text-[13px] font-semibold">Secret and ticket call</span>
                    <span className="text-[12px] text-muted-foreground">as for its other panels</span>
                  </div>
                ) : null}
                <Step n="3" title="In the page, where the chart goes" onCopy={() => copy(done.reads.map((r) => panelTag(origin, r, range)).join("\n\n"), done.reads.length > 1 ? "Tags" : "Tag")}>
                  <pre className={codeBox}>{done.reads.map((r) => panelTag(origin, r, range)).join("\n\n")}</pre>
                  <span className="text-[11px] text-muted-foreground">Serve your own copy of embed.js, with data-origin, to keep a fallback when Toposcope is down.</span>
                </Step>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-[13px] font-semibold">How it will look there</span>
                {preview ? (
                  <iframe title="Preview through the share" src={preview} className="h-[240px] w-full rounded-[6.4px] border border-white/10" />
                ) : (
                  <div className="h-[240px] animate-pulse rounded-[6.4px] bg-muted/40" />
                )}
                <span className="text-[11px] text-muted-foreground">Live, through the share: exactly what the site can read.</span>
              </div>
            </div>
            <DialogFooter className="justify-end">
              <button type="button" className="h-8 rounded-[4.4px] border border-input px-3 text-[13px] hover:bg-accent" onClick={() => onOpenChange(false)}>
                Done
              </button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, onCopy, children }: { n: string; title: string; onCopy: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12px] text-plate">{n}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="flex-1" />
        <button type="button" className="h-[22px] rounded-[4.4px] border border-input px-2 text-[11px] hover:bg-accent" onClick={onCopy}>
          Copy
        </button>
      </div>
      {children}
    </div>
  );
}

function ticketCall(origin: string): string {
  return `const { ticket } = await fetch(\n  "${origin}/share/v1/tickets",\n  { method: "POST", headers: {\n    authorization: \`Bearer \${process.env.TOPOSCOPE_SHARE}\` } }\n).then((r) => r.json());`;
}

function readWords(r: PanelRead): string {
  return r.kind === "metric" ? `${r.ref}${r.split ? ` · split ${r.split}` : ""}` : r.kind === "logs" ? `log ${r.agg}` : `top ${r.n} by ${r.key}`;
}

function scopeWords(scope: ProposedScope): string {
  return [scope.metric_names.join(" "), scope.metric_labels, scope.logs ? `logs ${scope.logs}` : "", scope.split.length ? `one line per ${scope.split.join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
}
