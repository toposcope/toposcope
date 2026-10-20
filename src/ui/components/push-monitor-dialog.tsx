import { X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  formatSpan,
  maskKey,
  monitorQuery,
  parseEvery,
  parseGrace,
  parsePushName,
  randomPingKey,
  viaLabel,
} from "../../shared/push";
import type { MonitorPage, MonitorView, PushResultRow } from "@/types";
import { Badge } from "@/components/watch-view";
import { pushValue } from "@/watch";

export type PushDraft = { mode: "create" } | { mode: "edit"; rule: MonitorView };

/** What the editor sends: a push monitor's schedule, its own webhook (null: the default), and a key it minted. */
export type PushInput = {
  name: string;
  every: string | null;
  grace: string | null;
  webhook_url: string | null;
  key?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: PushDraft | null;
  onCreate: (input: PushInput) => Promise<void>;
  onUpdate: (id: string, input: PushInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

const fld = "grid grid-cols-[110px_minmax(0,1fr)] items-start gap-3";
const lab = "pt-1.5 text-[12px] text-muted-foreground";
const box =
  "flex min-h-[30px] items-center gap-2 rounded-md border border-white/15 px-2.5 py-[5px] text-[13px] outline-none focus-within:border-white/40";
const code =
  "block overflow-hidden rounded-[5px] border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2 text-left font-mono text-[11.5px] leading-[1.55] whitespace-pre text-zinc-200 hover:border-white/25";

const pad = (n: number) => String(n).padStart(2, "0");
const hhmmss = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function Way({ n, title, children, help }: { n: number; title: string; children: React.ReactNode; help: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-2 text-[12.5px] font-semibold">
        <span className="inline-flex size-[18px] items-center justify-center rounded-full bg-[#27272a] text-[10.5px] text-plate">
          {n}
        </span>
        {title}
      </span>
      {children}
      <span className="text-[11.5px] leading-[1.45] text-muted-foreground">{help}</span>
    </div>
  );
}

/** A code block that copies what it stands for (the whole key, where it shows a part). */
function CopyCode({ shown, copied }: { shown: string; copied: string }) {
  return (
    <button
      type="button"
      className={code}
      title="Copy"
      onClick={() =>
        void navigator.clipboard.writeText(copied).then(
          () => toast.success("Copied"),
          () => toast.error("Copy failed"),
        )
      }
    >
      {shown}
    </button>
  );
}

/** 18s's first result: what arrived, and the row and value it was kept as. */
function FirstResult({ name, result }: { name: string; result: PushResultRow | null }) {
  if (!result) {
    return (
      <div className="rounded-md border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2 text-[12px] text-muted-foreground">
        Waiting for its first result…
      </div>
    );
  }
  const value = pushValue(result.value, result.unit);
  const head = [
    result.host ? `from ${result.host}` : "",
    viaLabel(result.via),
    result.exit_code !== null ? `exit ${result.exit_code}` : "",
  ].filter(Boolean);
  const row = [monitorQuery(name), `status:${result.status}`, result.host && result.via !== "ping" ? `host:${result.host}` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2">
      <span className="flex min-w-0 items-center gap-2 font-mono text-[12.5px]">
        <span className="size-2 shrink-0 rounded-full bg-sky-400" />
        <span>{hhmmss(result.at)}</span>
        <Badge tone={result.status === "fail" ? "red" : result.status === "warn" ? "amber" : "sec"}>{result.status}</Badge>
        {value ? <span>{value}</span> : null}
        {head.length > 0 ? <span className="truncate text-muted-foreground">{head.join(" · ")}</span> : null}
      </span>
      {result.message ? (
        <span className="truncate font-mono text-[13px]" title={result.message}>
          {result.message.split("\n", 1)[0]}
        </span>
      ) : null}
      <span className="text-[11.5px] text-muted-foreground">
        Kept as a row: <span className="font-mono text-foreground">{row}</span>.
        {value ? (
          <>
            {" "}
            The value is on the Series overlay as <span className="font-mono text-foreground">monitor_value</span>.
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Frame 18s: a push monitor. Any script tells Toposcope how it went: a cron line through its
 * keyed URL, a Nagios plugin through `toposcope.sh check`, or code through `POST /v1/checks`.
 * Its key is shown here and on its rail, nowhere else.
 */
export function PushMonitorDialog({ open, onOpenChange, draft, onCreate, onUpdate, onDelete }: Props) {
  const editing = draft?.mode === "edit" ? draft.rule : null;
  const [name, setName] = useState("");
  const [every, setEvery] = useState("");
  const [grace, setGrace] = useState("");
  const [own, setOwn] = useState(false);
  const [ownUrl, setOwnUrl] = useState("");
  const [minted, setMinted] = useState("");
  const [page, setPage] = useState<MonitorPage | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    setPage(null);
    setMinted(randomPingKey());
    if (draft.mode === "edit") {
      setName(draft.rule.name);
      setEvery(draft.rule.every_ms ? formatSpan(draft.rule.every_ms) : "");
      setGrace(draft.rule.grace_ms != null ? formatSpan(draft.rule.grace_ms) : "");
      setOwn(Boolean(draft.rule.webhook_url));
      setOwnUrl(draft.rule.webhook_url ?? "");
    } else {
      setName("");
      setEvery("");
      setGrace("");
      setOwn(false);
      setOwnUrl("");
    }
    void fetch("/api/settings")
      .then((res) => (res.ok ? (res.json() as Promise<{ default_webhook_url?: string | null }>) : null))
      .then((json) => setFallback(json?.default_webhook_url ?? null))
      .catch(() => undefined);
  }, [open, draft]);

  // The monitor of this name, if it is there: a first result may make it while this is open.
  const lookup = editing ? editing.name : name.trim();
  useEffect(() => {
    if (!open || !lookup || typeof parsePushName(lookup) !== "string") {
      setPage(null);
      return;
    }
    let stop = false;
    const read = async () => {
      const res = await fetch(`/api/monitors/${encodeURIComponent(lookup)}`).catch(() => null);
      if (stop) {
        return;
      }
      if (res?.ok) {
        setPage((await res.json()) as MonitorPage);
      } else if (res?.status === 404) {
        setPage(null);
      }
    };
    const first = setTimeout(() => void read(), 300);
    const every3s = setInterval(() => void read(), 3000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(every3s);
    };
  }, [open, lookup]);

  // A monitor its first result made while this was open: what the result said fills what is empty.
  const madeId = !editing && page?.source === "push" ? page.id : null;
  useEffect(() => {
    if (!madeId || !page) {
      return;
    }
    if (page.every_ms) {
      setEvery((prev) => prev || formatSpan(page.every_ms!));
    }
    if (page.grace_ms != null) {
      setGrace((prev) => prev || formatSpan(page.grace_ms!));
    }
    // Once per monitor it finds, not on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [madeId]);

  const taken = page && page.source !== "push" ? page.source : null;
  const key = page?.source === "push" && page.ping_key ? page.ping_key : minted;
  const shownName = name.trim() || "disk-var";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const everyMs = every.trim() ? parseEvery(every) : null;
  const graceMs = grace.trim() ? parseGrace(grace) : null;
  const everyBad = every.trim() !== "" && everyMs === null;
  const graceBad = grace.trim() !== "" && graceMs === null;
  const nameOk = typeof parsePushName(name) === "string";
  const urlOk = !own || /^https?:\/\/\S+$/.test(ownUrl.trim());

  const lines = useMemo(() => {
    const ping = `${origin}/ping/`;
    const json = [
      `[{ "monitor": ${JSON.stringify(shownName)},`,
      `   "status": "warn", "value": 87.2,`,
      `   "unit": "%"${every.trim() ? `, "every": ${JSON.stringify(every.trim())}` : ""},`,
      `   "message": "/var 87% used" }]`,
    ];
    return {
      cronShown: `curl -fsS -m 10 \\\n  ${ping}\\\n  ${key ? maskKey(key) : "<key>"}/$?`,
      cronCopied: `curl -fsS -m 10 ${ping}${key}/$?`,
      nagios: `toposcope.sh check ${shownName.includes(" ") ? JSON.stringify(shownName) : shownName} -- \\\n  /usr/lib/nagios/plugins/\\\n  check_disk -w 20% -c 10% -p /var`,
      code: [`POST /v1/checks`, `Authorization: Bearer $TOKEN`, ...json].join("\n"),
    };
  }, [origin, key, shownName, every]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || everyBad || graceBad || !urlOk || taken) {
      return;
    }
    const input: PushInput = {
      name: name.trim(),
      every: every.trim() || null,
      grace: grace.trim() || null,
      webhook_url: own ? ownUrl.trim() : null,
    };
    setBusy(true);
    try {
      if (editing) {
        await onUpdate(editing.id, input);
      } else {
        // A monitor its first result made keeps its key; a new one takes the one shown here.
        await onCreate(page?.source === "push" ? input : { ...input, key: minted });
      }
      onOpenChange(false);
    } catch {
      // The toast said why.
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) {
      return;
    }
    setBusy(true);
    try {
      await onDelete(editing.id);
      onOpenChange(false);
    } catch {
      // The toast said why.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(1140px,calc(100vw-32px))] overflow-y-auto p-0">
        <form onSubmit={(e) => void onSubmit(e)}>
          <div className="flex items-center gap-3 border-b px-[18px] py-3.5">
            <DialogTitle className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-normal text-muted-foreground">{editing ? "Push" : "New monitor"}</span>
              <span className="font-normal text-muted-foreground">/</span>
              <span className="truncate">{editing ? editing.name : "Push"}</span>
            </DialogTitle>
            <DialogDescription className="truncate">a script tells Toposcope how it went</DialogDescription>
            <button
              type="button"
              aria-label="Close"
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="flex flex-col gap-3.5 px-[18px] py-3.5">
            <div className={fld}>
              <label htmlFor="push-name" className={lab}>
                Name
              </label>
              <span className="flex flex-col gap-1">
                <span className={box}>
                  <input
                    id="push-name"
                    value={name}
                    autoFocus={!editing}
                    maxLength={100}
                    placeholder="disk-var"
                    onChange={(e) => setName(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[14px] outline-none placeholder:text-muted-foreground"
                  />
                </span>
                {taken ? (
                  <span className="text-[11.5px] text-red-300">A {taken} monitor has this name.</span>
                ) : name && !nameOk ? (
                  <span className="text-[11.5px] text-red-300">{(parsePushName(name) as { error: string }).error}</span>
                ) : null}
              </span>
            </div>

            <div className={fld}>
              <span className={lab}>Expect a result</span>
              <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                every
                <input
                  aria-label="every"
                  value={every}
                  placeholder="5m"
                  onChange={(e) => setEvery(e.target.value)}
                  className={cn(box, "w-[72px] bg-transparent font-mono text-foreground", everyBad && "border-red-500/60")}
                />
                then wait
                <input
                  aria-label="then wait"
                  value={grace}
                  placeholder={everyMs ? formatSpan(Math.min(everyMs, 60 * 60_000)) : "2m"}
                  onChange={(e) => setGrace(e.target.value)}
                  className={cn(box, "w-[72px] bg-transparent font-mono text-foreground", graceBad && "border-red-500/60")}
                />
                <span>before it opens · leave empty if it only reports when something happens</span>
              </span>
            </div>

            <div className={fld}>
              <span className={lab}>Send results</span>
              <span className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3">
                <Way
                  n={1}
                  title="From a cron line"
                  help="No token: the key is in the URL. /start, /fail, /<exit code>; a POST body is the message."
                >
                  <CopyCode shown={lines.cronShown} copied={lines.cronCopied} />
                </Way>
                <Way
                  n={2}
                  title="Any Nagios plugin"
                  help="Exit 0 ok, 1 warn, 2 fail, 3 unknown; the plugin's first line is the message, its perfdata the value."
                >
                  <CopyCode shown={lines.nagios} copied={lines.nagios.replace(/\\\n\s*/g, "")} />
                </Way>
                <Way
                  n={3}
                  title="From your own code"
                  help="Up to 500 a request. A name not seen before creates its monitor; skip this dialog."
                >
                  <CopyCode shown={lines.code} copied={lines.code} />
                </Way>
              </span>
            </div>

            <div className={fld}>
              <span className={lab}>First result</span>
              <FirstResult name={shownName} result={page?.source === "push" ? (page.last ?? null) : null} />
            </div>

            <div className={fld}>
              <span className={lab}>Calls</span>
              <span className="flex min-w-0 flex-wrap items-center gap-3">
                {own ? (
                  <span className={cn(box, "min-w-[280px] flex-1", !urlOk && "border-red-500/60")}>
                    <input
                      aria-label="Its own webhook"
                      type="url"
                      value={ownUrl}
                      placeholder="https://…"
                      onChange={(e) => setOwnUrl(e.target.value)}
                      className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
                    />
                  </span>
                ) : (
                  <span className={cn(box, "min-w-[280px] flex-1 font-mono")}>
                    <span className="truncate">default · {fallback ?? "none set"}</span>
                  </span>
                )}
                <span className="text-[12.5px] text-muted-foreground">set in Settings, for any monitor without its own</span>
                <button type="button" className="text-[12.5px] hover:underline" onClick={() => setOwn(!own)}>
                  {own ? "The default…" : "Its own…"}
                </button>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t px-[18px] py-3">
            <span className="text-[12.5px] text-muted-foreground">A warn shows on Watch and calls nobody. A fail opens it.</span>
            <span className="flex-1" />
            {editing ? (
              <Button type="button" variant="ghost" className="h-8 text-destructive" disabled={busy} onClick={() => void remove()}>
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-8" disabled={busy || !nameOk || everyBad || graceBad || !urlOk || Boolean(taken)}>
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
