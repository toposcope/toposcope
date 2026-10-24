import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogControl,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCompactCount } from "@/count-format";
import { cn } from "@/lib/utils";
import { expiresSoon, limitsLine, scopeLine, shareIsLive, type ShareView } from "@/share-cover";
import { announceShares } from "@/use-shares";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A share's use rows as a hunt in a new tab. */
  onOpenUse: (q: string) => void;
};

type Draft = {
  name: string;
  names: string;
  labels: string;
  logs: string;
  split: string;
  narrow: string;
  minStep: string;
  maxRange: string;
  maxLookback: string;
  rate: string;
  expires: string;
  frames: string;
};

const sectionLabel = "pt-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const inputClass = "min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground";
const rowButton = "h-6 rounded-[4.4px] px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground";

function blankDraft(): Draft {
  return {
    name: "",
    names: "",
    labels: "",
    logs: "",
    split: "",
    narrow: "",
    minStep: "1m",
    maxRange: "7d",
    maxLookback: "30d",
    rate: "120",
    expires: new Date(Date.now() + 365 * 86_400_000 - 86_400_000).toISOString().slice(0, 10),
    frames: "",
  };
}

function draftOf(share: ShareView): Draft {
  return {
    name: share.name,
    names: share.scope.metric_names.join(" "),
    labels: share.scope.metric_labels,
    logs: share.scope.logs ?? "",
    split: share.scope.split.join(" "),
    narrow: share.scope.narrow.join(" "),
    minStep: share.limits.min_step,
    maxRange: share.limits.max_range,
    maxLookback: share.limits.max_lookback,
    rate: String(share.limits.reads_per_minute),
    expires: new Date(share.expires_at).toISOString().slice(0, 10),
    frames: share.embed.frame_ancestors.join(" "),
  };
}

function bodyOf(draft: Draft, keepTtl: string | undefined) {
  const words = (text: string) => text.split(/[\s,]+/).filter(Boolean);
  return {
    expires_at: draft.expires.trim(),
    scope: {
      metric_names: words(draft.names),
      metric_labels: draft.labels.trim(),
      logs: draft.logs.trim() || null,
      split: words(draft.split),
      narrow: words(draft.narrow),
    },
    limits: {
      min_step: draft.minStep.trim(),
      max_range: draft.maxRange.trim(),
      max_lookback: draft.maxLookback.trim(),
      reads_per_minute: Number(draft.rate),
    },
    embed: { frame_ancestors: words(draft.frames), ...(keepTtl ? { ticket_ttl: keepTtl } : {}) },
  };
}

function when(iso: string | null, now: number): string {
  if (!iso) return "never read";
  const ms = Date.parse(iso);
  return now - ms < 86_400_000 ? `last read ${new Date(ms).toISOString().slice(11, 16)}` : `last read ${iso.slice(0, 10)}`;
}

/** How many of the window's metric names the patterns take in (23h). */
function useNameCount(patterns: string, open: boolean): number | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetch("/api/metric-names?range=24h")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { keys?: Array<{ k: string }> } | null) => setNames(json?.keys?.map((k) => k.k) ?? null))
      .catch(() => setNames(null));
  }, [open]);
  const words = patterns.split(/[\s,]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (!names || words.length === 0) return null;
  return names.filter((n) => words.some((p) => (p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p))).length;
}

/** Settings → Shares (#228, frames 23g–23j). */
export function SharesDialog({ open, onOpenChange, onOpenUse }: Props) {
  const [shares, setShares] = useState<ShareView[]>([]);
  const [mode, setMode] = useState<"list" | "new" | "edit">("list");
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [editing, setEditing] = useState<ShareView | null>(null);
  const [made, setMade] = useState<{ name: string; secret: string } | null>(null);
  const [arming, setArming] = useState<string | null>(null);
  const nameCount = useNameCount(draft.names, open && mode !== "list");
  const now = Date.now();

  async function load() {
    const res = await fetch("/api/shares");
    if (!res.ok) {
      toast.error("Failed to load shares");
      return;
    }
    const json = (await res.json()) as { shares: ShareView[] };
    setShares(json.shares);
    announceShares(json.shares);
  }

  useEffect(() => {
    if (open) {
      setMode("list");
      setMade(null);
      setArming(null);
      void load();
    }
  }, [open]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const name = draft.name.trim().toLowerCase();
    const res = await fetch(mode === "new" ? "/api/shares" : `/api/shares/${encodeURIComponent(name)}`, {
      method: mode === "new" ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...bodyOf(draft, editing?.embed.ticket_ttl) }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; secret?: string };
    if (!res.ok) {
      toast.error(json.error ?? `Save failed (${res.status})`);
      return;
    }
    await load();
    if (json.secret) {
      setMade({ name, secret: json.secret });
    } else {
      toast.success(`${name} saved`);
    }
    setMode("list");
  }

  async function onRevoke(name: string) {
    const res = await fetch(`/api/shares/${encodeURIComponent(name)}`, { method: "DELETE" });
    setArming(null);
    if (!res.ok) {
      toast.error(`Revoke failed (${res.status})`);
      return;
    }
    toast.success(`${name} revoked`);
    await load();
  }

  const origin = window.location.origin;

  if (made) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{made.name} created</DialogTitle>
            <DialogDescription>Copy the secret now. It is not shown again; a lost secret means a new share.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3.5">
            <DialogField label="Secret · keep it on your backend">
              <DialogControl className="border-plate/50 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{made.secret}</code>
                <Button
                  type="button"
                  className="h-6 px-2.5 text-[12px]"
                  onClick={() => void navigator.clipboard.writeText(made.secret).then(() => toast.success("Secret copied"))}
                >
                  Copy
                </Button>
              </DialogControl>
            </DialogField>
            <DialogField label="Mint a ticket per page load">
              <pre className="m-0 overflow-x-auto rounded-[4.4px] border border-white/12 bg-background px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-zinc-300">
                {`curl -X POST ${origin}/share/v1/tickets \\\n  -H "Authorization: Bearer $TOPOSCOPE_SHARE"\n→ { "ticket": "…", "expires_at": "…" }`}
              </pre>
            </DialogField>
            <DialogField label="Then, in the page">
              <pre className="m-0 overflow-x-auto rounded-[4.4px] border border-white/12 bg-background px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-zinc-300">
                {`<script src="${origin}/embed.js"\n  data-ticket="…" data-metric="…"\n  data-range="24h"></script>`}
              </pre>
            </DialogField>
          </div>
          <DialogFooter className="justify-end">
            <DialogClose type="button" className="border border-input" onClick={() => setMade(null)}>
              Done
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (mode !== "list") {
    const field = (key: keyof Draft, opts: { id: string; placeholder?: string; disabled?: boolean; aside?: string | null }) => (
      <DialogControl className={opts.disabled ? "opacity-60" : undefined}>
        <input
          id={opts.id}
          value={draft[key]}
          disabled={opts.disabled}
          placeholder={opts.placeholder}
          onChange={(e) => set(key, e.target.value)}
          className={inputClass}
        />
        {opts.aside ? <span className="shrink-0 text-[11px] text-muted-foreground">{opts.aside}</span> : null}
      </DialogControl>
    );
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{mode === "new" ? "New share" : `Edit ${editing?.name}`}</DialogTitle>
            <DialogDescription>Everything read with this share is inside this scope. Series and counts only.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3.5" onSubmit={(e) => void onSave(e)}>
            <DialogField label="Name">{field("name", { id: "share-name", placeholder: "agental-console", disabled: mode === "edit" })}</DialogField>
            <div className={sectionLabel}>Scope</div>
            <DialogField label="Metric names">
              {field("names", { id: "share-names", placeholder: "fleet_*", aside: nameCount === null ? null : `${nameCount} names in 24h` })}
            </DialogField>
            <DialogField label="Metric labels" help="Added to every metric read.">
              {field("labels", { id: "share-labels", placeholder: "service:agental" })}
            </DialogField>
            <DialogField label="Logs" help="Counts, rates and percentiles of matching rows. Never the rows.">
              {field("logs", { id: "share-logs", placeholder: "none · this share reads no logs" })}
            </DialogField>
            <div className="grid grid-cols-2 gap-3">
              <DialogField label="Split by" help="Values of these keys are shown.">
                {field("split", { id: "share-split", placeholder: "host pool" })}
              </DialogField>
              <DialogField label="Narrow by" help="A panel may add key:value on these.">
                {field("narrow", { id: "share-narrow", placeholder: "host pool" })}
              </DialogField>
            </div>
            <div className={sectionLabel}>Limits</div>
            <div className="grid grid-cols-4 gap-3">
              <DialogField label="Finest bar">{field("minStep", { id: "share-step" })}</DialogField>
              <DialogField label="Longest window">{field("maxRange", { id: "share-range" })}</DialogField>
              <DialogField label="Reaches back">{field("maxLookback", { id: "share-back" })}</DialogField>
              <DialogField label="Reads / min">{field("rate", { id: "share-rate" })}</DialogField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DialogField label="Expires" help="At most a year out.">
                {field("expires", { id: "share-expires", placeholder: "2027-10-23" })}
              </DialogField>
              <DialogField label="May be framed by" help="Empty: JSON only, no embed.">
                {field("frames", { id: "share-frames", placeholder: "https://admin.example.com" })}
              </DialogField>
            </div>
            <DialogFooter className="justify-end">
              <button type="button" className="h-8 rounded-[4.4px] border border-input px-3 text-[13px] hover:bg-accent" onClick={() => setMode("list")}>
                Cancel
              </button>
              <Button type="submit" className="h-8 bg-plate text-[#18181b] hover:bg-plate/90" disabled={!draft.name.trim()}>
                {mode === "new" ? "Create share" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Shares</DialogTitle>
          <DialogDescription>Another app reads numbers in one scope: series and counts, never events.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col border-t border-white/[0.08]">
          {shares.length === 0 ? (
            <div className="my-3 flex flex-col items-center gap-2.5 rounded-[6.4px] border border-dashed border-white/12 px-4 py-7 text-center">
              <span className="text-[13px] font-medium">No shares yet</span>
              <span className="text-[13px] leading-[1.5] text-muted-foreground">
                Start from the chart you want to show: <span className="text-foreground">Share…</span> in a panel's copy menu, or{" "}
                <span className="text-foreground">Share panels…</span> on a board.
              </span>
              <span className="text-[12px] text-muted-foreground/70">This list is where you see how each share is used, change it, or revoke it.</span>
            </div>
          ) : null}
          {shares.map((share) => {
            const live = shareIsLive(share, now);
            const soon = expiresSoon(share, now);
            if (arming === share.name) {
              return (
                <div key={share.name} className="my-2 flex flex-col gap-2.5 rounded-[6.4px] border border-red-400/45 bg-red-400/[0.06] p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-[13px] font-semibold">{share.name}</span>
                      <span className="truncate font-mono text-[12px] text-zinc-300">{scopeLine(share)}</span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">{formatCompactCount(share.use?.reads_24h ?? 0)} reads 24h</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[13px]">Revoke? Its secret and every ticket stop now; panels show “expired”.</span>
                    <button type="button" className="h-7 rounded-[4.4px] border border-input px-2.5 text-[12px] hover:bg-accent" onClick={() => setArming(null)}>
                      Keep
                    </button>
                    <button
                      type="button"
                      className="h-7 rounded-[4.4px] bg-red-400 px-2.5 text-[12px] font-semibold text-[#18181b] hover:bg-red-400/90"
                      onClick={() => void onRevoke(share.name)}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div key={share.name} className={cn("group/share flex items-start gap-3 border-b border-white/[0.08] py-3 last:border-b-0", !live && "opacity-55")}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={cn("text-[13px] font-semibold", share.revoked_at !== null && "line-through")}>{share.name}</span>
                  <span className="truncate font-mono text-[12px] text-zinc-300">{scopeLine(share)}</span>
                  <span className={cn("font-mono text-[11px]", soon ? "text-amber-400" : "text-muted-foreground")}>
                    {share.revoked_at !== null
                      ? `revoked ${new Date(share.revoked_at).toISOString().slice(0, 10)}`
                      : !live
                        ? `expired ${new Date(share.expires_at).toISOString().slice(0, 10)}`
                        : soon ?? limitsLine(share)}
                  </span>
                </div>
                {live ? (
                  <div className="flex flex-col items-end gap-1 font-mono text-[11px] text-muted-foreground">
                    <span>{when(share.use?.last_read_at ?? null, now)}</span>
                    <span className="text-zinc-300">{formatCompactCount(share.use?.reads_24h ?? 0)} reads 24h</span>
                    {share.use && share.use.refused_24h > 0 ? (
                      <button
                        type="button"
                        className="text-amber-400 hover:underline"
                        onClick={() => onOpenUse(`service:toposcope share:"${share.name}"`)}
                      >
                        {formatCompactCount(share.use.refused_24h)} refused
                      </button>
                    ) : (
                      <span>0 refused</span>
                    )}
                    <span className="flex gap-1 pt-0.5">
                      <button
                        type="button"
                        className={rowButton}
                        onClick={() => {
                          setEditing(share);
                          setDraft(draftOf(share));
                          setMode("edit");
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className={rowButton} onClick={() => setArming(share.name)}>
                        Revoke
                      </button>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter className="justify-end">
          <Button
            type="button"
            className="h-8 bg-plate text-[#18181b] hover:bg-plate/90"
            onClick={() => {
              setEditing(null);
              setDraft(blankDraft());
              setMode("new");
            }}
          >
            {shares.length === 0 ? "New share by hand" : "New share"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
