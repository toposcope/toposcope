import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { compileQuery } from "../../query/compile";
import type { SavedSearch } from "@/types";
import { InstanceToken } from "./instance-token";
import { QueryText } from "./query-text";

/**
 * Minting and pasting (#136): frames 7a–8b and 10a of Toposcope Links.html. A strip that never
 * moves says the direction: source on the left, puller on the right, "here" plate-outlined.
 */

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function day(ms: number): string {
  const d = new Date(ms);
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function dayTime(ms: number): string {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function DirectionStrip({
  source,
  puller,
  sentence,
  sourceLabel = "Source",
}: {
  source: { name: string; here?: boolean; dashed?: boolean };
  puller: { name: string; here?: boolean; dashed?: boolean };
  sentence: string;
  sourceLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-background/60 px-3 py-2.5">
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{sourceLabel}</span>
          <InstanceToken {...source} />
        </div>
        <div className="flex flex-col items-center pb-0.5 text-[10.5px] text-muted-foreground">
          rows
          <span className="text-[15px] leading-none">⟶</span>
        </div>
        <div className="flex min-w-0 flex-col items-end gap-1">
          <span className="text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Pulled by</span>
          <InstanceToken {...puller} />
        </div>
      </div>
      <p className="mt-2 text-[13px]">{sentence}</p>
    </div>
  );
}

function CopyField({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[4.4px] border border-white/10 bg-background/40 px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{children}</span>
      <button
        type="button"
        className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          toast.success("Copied");
        }}
      >
        Copy
      </button>
    </div>
  );
}

function FilterShown({ q }: { q: string }) {
  return q.trim() === "" ? (
    <span className="font-sans">
      Every row <span className="text-muted-foreground">— no filter</span>
    </span>
  ) : (
    <QueryText q={q} />
  );
}

function NameField({ value, onChange, who }: { value: string; onChange: (v: string) => void; who: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium">Name this instance</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. edge-fra"
        className="h-9 rounded-[4.4px] border border-white/20 bg-transparent px-2.5 font-mono text-[13px] outline-none focus:border-ring"
      />
      <span className="text-[11.5px] text-muted-foreground">{who} sees this name. Asked once; after that it lives in Settings.</span>
    </label>
  );
}

type Minted = { key: string; label: string; q: string; until: number | null };

/** Offer rows from here (7a) or invite a source here (7b): pick the filter, mint, copy once. */
export function MintDialog({
  kind,
  here,
  onClose,
  onMinted,
}: {
  kind: "offer" | "invite" | null;
  here: string | null;
  onClose: () => void;
  onMinted: () => void;
}) {
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [savedId, setSavedId] = useState("");
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [many, setMany] = useState(false);
  const [until, setUntil] = useState("");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!kind) {
      return;
    }
    setName("");
    setQ("");
    setSavedId("");
    setMany(false);
    setMinted(null);
    const d = new Date(Date.now() + 14 * 86_400_000);
    setUntil(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`);
    void fetch("/api/saved-searches")
      .then((res) => (res.ok ? res.json() : []))
      .then((json: SavedSearch[] | { searches?: SavedSearch[] }) => setSaved(Array.isArray(json) ? json : (json.searches ?? [])));
  }, [kind]);

  const offer = kind === "offer";
  const me = here ?? (name.trim() || "this instance");
  const faults = compileQuery(q).faults;
  const untilMs = Date.parse(`${until}:00Z`);
  const days = Number.isFinite(untilMs) ? Math.round((untilMs - Date.now()) / 86_400_000) : NaN;
  const untilOk = !many || (Number.isFinite(untilMs) && untilMs > Date.now() && days <= 30);

  async function mint() {
    setBusy(true);
    try {
      const res = await fetch(`/api/links/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, name: here ? undefined : name, until: !offer && many ? untilMs : null }),
      });
      const json = (await res.json()) as Minted & { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? `Mint failed (${res.status})`);
        return;
      }
      setMinted(json);
      onMinted();
    } finally {
      setBusy(false);
    }
  }

  const strip = offer ? (
    <DirectionStrip source={{ name: me, here: true }} puller={{ name: "whoever pastes the key", dashed: true }} sentence="Rows leave here." />
  ) : minted && minted.until !== null ? (
    <DirectionStrip
      sourceLabel="Sources"
      source={{ name: "each instance that pastes", dashed: true }}
      puller={{ name: me, here: true }}
      sentence="Rows arrive here — one link per instance that pastes."
    />
  ) : (
    <DirectionStrip source={{ name: "whoever pastes the key", dashed: true }} puller={{ name: me, here: true }} sentence="Rows arrive here." />
  );

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{offer ? "Offer rows from here" : "Invite a source here"}</DialogTitle>
          <DialogDescription>
            {minted
              ? "Copy the key now. It is shown once."
              : offer
                ? "Mints one key. Whoever pastes it may pull rows matching the filter from this instance."
                : "Mints one key. Whoever pastes it lets this instance pull rows from them."}
          </DialogDescription>
        </DialogHeader>
        {minted ? (
          <div className="flex flex-col gap-3">
            {strip}
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Filter · fixed for {offer || minted.until === null ? "this link" : "these links"}</span>
              <CopyField text={minted.q}>
                <FilterShown q={minted.q} />
              </CopyField>
            </div>
            {!offer ? (
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium">The key works</span>
                <span className="text-[12.5px] text-muted-foreground">
                  {minted.until === null ? "Once" : `For many, until ${dayTime(minted.until)}`}
                </span>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Key</span>
              <CopyField text={minted.key}>{minted.key}</CopyField>
              <span className="text-[11.5px] text-muted-foreground">
                {minted.until === null
                  ? `Single use. Listed as ${minted.label} under ${offer ? "Pulled from here" : "Pulling into here"} until someone pastes it.`
                  : `Reusable until ${day(minted.until)}. Listed as ${minted.label} with a count of instances that used it.`}
              </span>
            </div>
            <div>
              <Button type="button" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {here ? null : <NameField value={name} onChange={setName} who="The other side" />}
            {strip}
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Filter</span>
              {offer && saved.length > 0 ? (
                <select
                  value={savedId}
                  onChange={(e) => {
                    setSavedId(e.target.value);
                    const item = saved.find((s) => s.id === e.target.value);
                    if (item) setQ(item.query);
                  }}
                  className="h-9 rounded-[4.4px] border border-white/15 bg-transparent px-2 text-[13px]"
                >
                  <option value="">Type key:value, or pick a saved search</option>
                  {saved.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · saved search
                    </option>
                  ))}
                </select>
              ) : null}
              <label className="flex h-9 items-center gap-2 rounded-[4.4px] border border-white/15 px-2.5 focus-within:border-ring">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setSavedId("");
                  }}
                  placeholder={offer ? "level:error service:api" : "level:error OR level:fatal"}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/60"
                />
              </label>
              {faults.length > 0 ? (
                <span className="text-[11.5px] text-destructive">{faults[0]?.msg}</span>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  {offer
                    ? "Pick a saved search or type key:value. Empty means every row. Fixed once minted."
                    : "Empty: every row the source has, message text included."}
                </span>
              )}
            </div>
            {!offer ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">The key works</span>
                <div className="grid grid-cols-2 rounded-[4.4px] border border-white/15 p-0.5">
                  {[false, true].map((m) => (
                    <button
                      key={String(m)}
                      type="button"
                      className={cn("h-8 rounded-[3px] text-[13px]", many === m ? "bg-white/10 text-foreground" : "text-muted-foreground")}
                      onClick={() => setMany(m)}
                    >
                      {m ? "For many, until a date" : "Once"}
                    </button>
                  ))}
                </div>
                {many ? (
                  <label className="flex h-9 items-center gap-2 rounded-[4.4px] border border-white/15 px-2.5">
                    <input
                      type="datetime-local"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                      className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
                    />
                    <span className={cn("text-[11.5px]", untilOk ? "text-muted-foreground" : "text-destructive")}>
                      {Number.isFinite(days) ? `in ${days} days · max 30` : "max 30 days"}
                    </span>
                  </label>
                ) : (
                  <span className="text-[11.5px] text-muted-foreground">Once: spent by the first instance that pastes it.</span>
                )}
              </div>
            ) : null}
            {offer ? (
              <p className="rounded-[4.4px] bg-white/[0.04] px-3 py-2 text-[13px]">
                {q.trim() === "" ? (
                  <>Every row on {me}, message text included, will leave this instance for whoever pastes the key.</>
                ) : (
                  <>
                    Rows matching <QueryText q={q.trim()} />, message text included, will leave this instance for whoever pastes the key.
                  </>
                )}
              </p>
            ) : null}
            <div className="flex items-center justify-between">
              <Button
                type="button"
                size="sm"
                disabled={busy || faults.length > 0 || !untilOk || (!here && !name.trim())}
                onClick={() => void mint()}
              >
                Mint key
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Preview = {
  kind: "offer" | "invite";
  name: string;
  url: string;
  kid: string;
  q: string;
  until: number | null;
  label: string;
  expired: boolean;
  lookup: { state: string; uses: number; minted_at: number; spent_at?: number | null; name: string | null } | null;
  lookup_failed: boolean;
};

/** Paste a key (8a, 8b, 10a): the preview before confirm, then the direction as a verb. */
export function PasteDialog({
  open,
  here,
  retentionDays,
  onClose,
  onLinked,
}: {
  open: boolean;
  here: string | null;
  retentionDays: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notKey, setNotKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (open) {
      setName("");
      setKey("");
      setPreview(null);
      setNotKey(null);
    }
  }, [open]);

  async function check(text: string) {
    const mine = ++seq.current;
    if (!text.trim()) {
      setPreview(null);
      setNotKey(null);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/links/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: text.trim() }),
      });
      const json = (await res.json()) as Preview & { error?: string; detail?: string };
      if (mine !== seq.current) return;
      if (!res.ok) {
        setPreview(null);
        setNotKey(json.detail ?? json.error ?? "Not a link key.");
        return;
      }
      setNotKey(null);
      setPreview(json);
    } finally {
      if (mine === seq.current) setChecking(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      const res = await fetch("/api/links/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), name: here ? undefined : name }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? `Failed (${res.status})`);
        void check(key);
        return;
      }
      toast.success(preview?.kind === "offer" ? `Pulling from ${preview.name}` : `${preview?.name} can pull from here`);
      onLinked();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const me = here ?? (name.trim() || "this instance");
  const p = preview;
  const offer = p?.kind === "offer";
  const state = p?.lookup?.state ?? null;
  const reason = p
    ? p.expired && p.until !== null
      ? `Expired ${dayTime(p.until)}. Ask ${p.name} for a new key.`
      : state === "used"
        ? `Already used${p.lookup?.spent_at ? `, ${dayTime(p.lookup.spent_at)}` : ""}. A single-use key works once.`
        : state === "revoked"
          ? `Revoked at ${p.name}. Ask ${p.name} for a new key.`
          : state === "expired"
            ? `Expired. Ask ${p.name} for a new key.`
            : state === "unknown"
              ? `${p.name} does not know this key. Ask ${p.name} for a new one.`
              : null
    : null;
  const usable = p !== null && !p.expired && state === "unused" && (here !== null || name.trim() !== "");
  const verb = p ? (offer ? `Pull from ${p.name}` : `Let ${p.name} pull from here`) : "Confirm";
  const facts = p
    ? [
        p.lookup?.minted_at ? dayTime(p.lookup.minted_at) : null,
        p.until === null ? "single use" : `reusable until ${day(p.until)}`,
        p.lookup && state === "unused" ? (p.until === null ? "unused" : `used by ${p.lookup.uses}`) : null,
      ].filter(Boolean)
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Paste a link key</DialogTitle>
          <DialogDescription>
            {here ? "A key minted on another instance. Nothing is pulled until you confirm." : "Nothing is pulled until you confirm."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {here ? null : <NameField value={name} onChange={setName} who={p ? p.name : "The other side"} />}
          <input
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              void check(e.target.value);
            }}
            placeholder="tsl1_…"
            spellCheck={false}
            className="h-9 rounded-[4.4px] border border-white/15 bg-transparent px-2.5 font-mono text-[12.5px] outline-none focus:border-ring"
          />
          {notKey ? (
            <div className="rounded-lg border border-white/10 bg-background/60 px-3 py-2.5">
              <p className="text-[13px] font-medium">Not a link key.</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{notKey.replace(/^Not a link key\.\s*/, "")}</p>
            </div>
          ) : null}
          {p ? (
            <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-background/60 px-3 py-2.5">
              <p className="text-[12.5px] text-muted-foreground">
                An <span className="text-foreground">{p.kind}</span> minted by <span className="font-mono text-foreground">{p.name}</span>
                {facts.length ? ` · ${facts.join(" · ")}` : ""}
                {p.lookup && state === "unused" ? ` — checked with ${p.name}` : ""}
              </p>
              <DirectionStrip
                source={offer ? { name: p.name } : { name: me, here: true }}
                puller={offer ? { name: me, here: true } : { name: p.name }}
                sentence={
                  offer
                    ? `Rows arrive here. This instance will pull from ${p.name}.`
                    : `Rows leave here. ${p.name} will pull from this instance.`
                }
              />
              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] text-muted-foreground">Filter, chosen by {p.name}</span>
                <CopyField text={p.q}>
                  <FilterShown q={p.q} />
                </CopyField>
              </div>
              {offer ? (
                <p className="text-[11.5px] text-muted-foreground">Pulled rows follow this instance’s retention, {retentionDays} days.</p>
              ) : (
                <p className="rounded-[4.4px] bg-white/[0.04] px-3 py-2 text-[13px]">
                  {p.q.trim() === "" ? (
                    <>Every row on {me}, message text included, will leave for {p.name}.</>
                  ) : (
                    <>
                      Rows matching <QueryText q={p.q} />, message text included, will leave for {p.name}.
                    </>
                  )}
                </p>
              )}
              {checking && !p.lookup ? (
                <p className="text-[12.5px] text-muted-foreground">Checking with {p.name} that the key is unused…</p>
              ) : null}
              {p.lookup_failed ? (
                <p className="flex items-center gap-2 text-[12.5px] text-amber-400">
                  {p.name} did not answer. The key may still be good.
                  <button type="button" className="text-foreground underline" onClick={() => void check(key)}>
                    Try again
                  </button>
                </p>
              ) : null}
              {reason ? <p className="text-[12.5px] text-red-400">{reason}</p> : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <Button type="button" size="sm" disabled={!usable || busy} onClick={() => void confirm()}>
              {verb}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
