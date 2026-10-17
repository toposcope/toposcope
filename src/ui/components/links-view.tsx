import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { InstanceToken } from "./instance-token";
import { QueryText } from "./query-text";
import { MintDialog, PasteDialog } from "./link-dialogs";
import {
  contactWords,
  keyPositionWords,
  linkClock,
  linkPositionWords,
  type LinkItem,
  type LinkKeyItem,
  type LinksList,
} from "../link-words";

/**
 * Links (#136): a fourth view. Every link reads source → puller, left to right; "here" is the
 * only plate-outlined token. Arriving above leaving. Frames 6a–6d of Toposcope Links.html.
 */

function Arrow() {
  return <span className="shrink-0 text-muted-foreground">⟶</span>;
}

function FilterCell({ q }: { q: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {q.trim() === "" ? (
        <span className="truncate text-[12.5px]">
          Every row <span className="text-muted-foreground">— no filter</span>
        </span>
      ) : (
        <QueryText q={q} className="min-w-0 truncate text-[12.5px]" />
      )}
      <button
        type="button"
        className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[4.4px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Copy the filter"
        aria-label="Copy the filter"
        onClick={() => {
          void navigator.clipboard.writeText(q);
          toast.success("Filter copied");
        }}
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  );
}

function PositionCell({ text, tone }: { text: string; tone: "ok" | "behind" | "quiet" | "key"; hollow?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-[12.5px]",
        tone === "behind" && "text-amber-400",
        tone === "quiet" && "text-red-400",
        tone === "key" && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "ok" && "bg-sky-400",
          tone === "behind" && "bg-amber-400",
          tone === "quiet" && "bg-red-400",
          tone === "key" && "border border-dashed border-muted-foreground bg-transparent",
        )}
      />
      {text}
    </span>
  );
}

const grid = "grid grid-cols-[minmax(0,1.45fr)_minmax(0,1.1fr)_minmax(0,0.95fr)_minmax(0,0.5fr)_auto] items-center gap-3";

type Row =
  | { kind: "link"; link: LinkItem; via: string | null }
  | { kind: "key"; key: LinkKeyItem };

function RemoveStrip({
  row,
  here,
  retentionDays,
  onRemove,
  onKeep,
}: {
  row: Row;
  here: string;
  retentionDays: number;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const words =
    row.kind === "key"
      ? `Revoke ${row.key.label}? Nobody can paste it after this. Links already made with it keep running.`
      : row.link.role === "pull"
        ? `Stop pulling from ${row.link.peer_name}? Rows already pulled stay here until retention ages them out (${retentionDays} days). Nothing is deleted; other links keep running.`
        : `Stop ${row.link.peer_name} pulling from here? ${row.link.peer_name} keeps the rows it already pulled, under its own retention. Nothing is deleted here or there.`;
  return (
    <div className="flex items-center gap-3 border-b border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[12.5px]">
      <span className="min-w-0 flex-1">{words}</span>
      <Button type="button" size="sm" variant="destructive" className="h-7" onClick={onRemove}>
        {row.kind === "key" ? "Revoke key" : "Remove link"}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onKeep}>
        Keep
      </Button>
      <span className="sr-only">{here}</span>
    </div>
  );
}

function LinkGroup({
  title,
  note,
  rows,
  here,
  now,
  retentionDays,
  onChanged,
}: {
  title: string;
  note: string;
  rows: Row[];
  here: string;
  now: number;
  retentionDays: number;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (rows.length === 0) {
    return null;
  }
  async function remove(row: Row) {
    const res =
      row.kind === "key"
        ? await fetch(`/api/links/keys/${row.key.kid}`, { method: "DELETE" })
        : await fetch(`/api/links/${row.link.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(`Failed (${res.status})`);
      return;
    }
    setConfirming(null);
    onChanged();
  }
  return (
    <section className="mt-5">
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="text-[12px] text-muted-foreground">{note}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{rows.length}</span>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className={`${grid} border-b px-3 py-1.5 text-[10.5px] tracking-[0.06em] text-muted-foreground uppercase`}>
          <span>Source → pulled by</span>
          <span>Filter · fixed</span>
          <span>Position</span>
          <span>Last contact</span>
          <span />
        </div>
        {rows.map((row) => {
          const id = row.kind === "key" ? row.key.kid : row.link.id;
          const pulling = row.kind === "key" ? row.key.kind === "invite" : row.link.role === "pull";
          const other =
            row.kind === "key" ? (
              <InstanceToken name={`whoever pastes ${row.key.label}`} dashed />
            ) : (
              <InstanceToken name={row.link.peer_name} />
            );
          const mine = <InstanceToken name={here} here />;
          const position =
            row.kind === "key"
              ? { text: keyPositionWords(row.key), tone: "key" as const }
              : linkPositionWords(row.link, now);
          return (
            <div key={id}>
              <div className={`${grid} border-b border-white/[0.08] px-3 py-2 last:border-0`}>
                <span className="flex min-w-0 items-center gap-2">
                  {pulling ? other : mine}
                  <Arrow />
                  {pulling ? mine : other}
                  {row.kind === "link" && row.via ? (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">via {row.via}</span>
                  ) : null}
                </span>
                <FilterCell q={row.kind === "key" ? row.key.q : row.link.q} />
                <span title={row.kind === "link" ? (row.link.last_error ?? undefined) : undefined}>
                  <PositionCell text={position.text} tone={position.tone} />
                </span>
                {row.kind === "link" && row.link.last_contact_at !== null ? (
                  <span className="flex flex-col font-mono text-[11.5px] leading-tight">
                    {linkClock(row.link.last_contact_at, now)}
                    <span className="font-sans text-[11px] text-muted-foreground">{contactWords(row.link)}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                <button
                  type="button"
                  className="h-7 rounded-[4.4px] px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setConfirming(confirming === id ? null : id)}
                >
                  {row.kind === "key" ? "Revoke" : "Remove"}
                </button>
              </div>
              {confirming === id ? (
                <RemoveStrip
                  row={row}
                  here={here}
                  retentionDays={retentionDays}
                  onRemove={() => void remove(row)}
                  onKeep={() => setConfirming(null)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EmptyLinks({ onOffer, onInvite, onPaste }: { onOffer: () => void; onInvite: () => void; onPaste: () => void }) {
  const starts = [
    { label: "Offer rows from here", a: "This one is reachable.", b: "Rows leave here.", go: onOffer },
    { label: "Invite a source here", a: "This one is reachable.", b: "Rows arrive here.", go: onInvite },
    { label: "Paste a key", a: "The other one is reachable.", b: "The key says which way.", go: onPaste, solid: true },
  ];
  return (
    <div className="mt-4 rounded-lg border bg-card px-6 py-8 text-center">
      <p className="text-sm font-medium">No links yet.</p>
      <p className="mx-auto mt-1 max-w-[460px] text-[12.5px] text-muted-foreground">
        The instance the other can reach mints a key; the other instance pastes it. Rows only ever move from the source to the
        instance that pulls.
      </p>
      <div className="mt-5 flex justify-center gap-6">
        {starts.map((s) => (
          <div key={s.label} className="flex w-[180px] flex-col items-center gap-1.5">
            <Button type="button" size="sm" variant={s.solid ? "default" : "outline"} onClick={s.go}>
              {s.label}
            </Button>
            <span className="text-[11.5px] leading-snug text-muted-foreground">
              {s.a}
              <br />
              {s.b}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LinksView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [list, setList] = useState<LinksList | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<"offer" | "invite" | "paste" | null>(null);

  async function load() {
    const res = await fetch("/api/links");
    if (res.ok) {
      setList((await res.json()) as LinksList);
      setNow(Date.now());
    }
  }

  useEffect(() => {
    void load();
    void fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { retention_days?: number } | null) => {
        if (json?.retention_days) setRetentionDays(json.retention_days);
      });
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, []);

  const here = list?.here.name ?? "";
  const reusable = new Map((list?.keys ?? []).filter((k) => k.until !== null).map((k) => [k.kid, k.label]));
  const rowsFor = (pulling: boolean): Row[] => [
    ...(list?.links ?? [])
      .filter((link) => (link.role === "pull") === pulling)
      .map((link) => ({ kind: "link" as const, link, via: reusable.get(link.kid) ?? null })),
    ...(list?.keys ?? [])
      .filter((key) => (key.kind === "invite") === pulling)
      .map((key) => ({ kind: "key" as const, key })),
  ];
  const pulling = rowsFor(true);
  const pulled = rowsFor(false);
  const empty = list !== null && pulling.length === 0 && pulled.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">Links</h1>
            <p className="text-xs text-muted-foreground">
              Rows this instance pulls from others, and rows others pull from it. Every link reads source → puller.
            </p>
          </div>
          {empty ? null : (
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setDialog("offer")}>
                Offer rows from here
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setDialog("invite")}>
                Invite a source here
              </Button>
              <Button type="button" size="sm" onClick={() => setDialog("paste")}>
                Paste a key
              </Button>
            </div>
          )}
        </div>
        {empty ? (
          <EmptyLinks onOffer={() => setDialog("offer")} onInvite={() => setDialog("invite")} onPaste={() => setDialog("paste")} />
        ) : list ? (
          <>
            <p className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              This instance is <InstanceToken name={here || "unnamed"} here /> — the name the other side sees.
              <button type="button" className="text-foreground hover:underline" onClick={onOpenSettings}>
                Rename in Settings
              </button>
            </p>
            <LinkGroup
              title="Pulling into here"
              note={`${here} pulls these rows from other instances · rows arrive`}
              rows={pulling}
              here={here}
              now={now}
              retentionDays={retentionDays}
              onChanged={() => void load()}
            />
            <LinkGroup
              title="Pulled from here"
              note={`other instances pull these rows from ${here} · rows leave`}
              rows={pulled}
              here={here}
              now={now}
              retentionDays={retentionDays}
              onChanged={() => void load()}
            />
          </>
        ) : null}
      </div>
      <MintDialog
        kind={dialog === "offer" || dialog === "invite" ? dialog : null}
        here={list?.here.name ?? null}
        onClose={() => setDialog(null)}
        onMinted={() => void load()}
      />
      <PasteDialog
        open={dialog === "paste"}
        here={list?.here.name ?? null}
        retentionDays={retentionDays}
        onClose={() => setDialog(null)}
        onLinked={() => void load()}
      />
    </div>
  );
}
