import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { serviceMissing, serviceOk, useSeenServices } from "@/components/monitor-place-fields";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MonitorPreview, PreviewWindow } from "../../alerts/preview";
import { seriesLabel } from "../../query/agg";
import type { OpensWhen } from "../../shared/monitor";
import { callHost } from "../watch";

/**
 * Watch this (#264, frame 26h): a sheet over the rows that makes a saved-search monitor from the
 * hunt. The condition is one sentence; the plot is where it would have opened in the last 24 h,
 * read with the evaluator's own comparison (`GET /api/monitors/preview`).
 */
export type WatchThisInput = {
  name: string;
  threshold: number;
  opensWhen: OpensWhen;
  window: PreviewWindow;
  /** Rows of this search, or their share of all rows in percent (#279). */
  measure: "series" | "share";
  /** Where it sends (#280): URLs, or `default` for the webhook in Settings. */
  webhookUrls: string[];
  /** The service it is about (#335): required. */
  service: string;
  /** The host it is about; may be empty. */
  host: string;
};

/** api from `service:api level:error`: the service a hunt names, to start the monitor's from. */
export function serviceOfQuery(q: string): string {
  const m = /(?:^|\s)service:(?:"([^"]+)"|([^\s"()]+))/.exec(q);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

const windows: PreviewWindow[] = ["5m", "15m", "1h"];

export function watchThisName(savedName: string | null, q: string, opensWhen: OpensWhen, threshold: number, measure: "series" | "share" = "series"): string {
  const what = savedName ?? (q.trim() || "All logs");
  return `${what} ${opensWhen === "fewer_than" ? "below" : "above"} ${threshold}${measure === "share" ? "%" : ""}`;
}

/** "ntfy.sh/ops", "hooks.slack.com/…/x": a target told apart from another on the same host. */
export function targetLabel(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return bare.length > 32 ? `${bare.slice(0, 18)}…${bare.slice(-12)}` : bare;
}

/** The webhooks a sheet can tick (26h): every URL a monitor already calls, newest kind first, once each. */
export function knownTargets(monitors: Array<{ webhook_url: string | null; webhook_urls?: string[] | null }>): string[] {
  const out: string[] = [];
  for (const m of monitors) {
    for (const u of m.webhook_urls && m.webhook_urls.length ? m.webhook_urls : [m.webhook_url ?? ""]) {
      if (u && u !== "default" && /^https?:\/\//.test(u) && !out.includes(u)) {
        out.push(u);
      }
    }
  }
  return out.slice(0, 8);
}

export function WatchThisSheet(props: {
  q: string;
  agg: string | null;
  savedName: string | null;
  /** The saved hunt, when there is one: a test call reads it. */
  savedId: string | null;
  /** A saved hunt's own window is the monitor's; an unsaved one picks it here. */
  savedRange: string | null;
  onSave: (input: WatchThisInput) => Promise<void>;
  onCancel: () => void;
}) {
  const fixed = props.savedRange && (windows as string[]).includes(props.savedRange) ? (props.savedRange as PreviewWindow) : null;
  const [opensWhen, setOpensWhen] = useState<OpensWhen>("at_least");
  const [threshold, setThreshold] = useState("10");
  const [win, setWin] = useState<PreviewWindow>(fixed ?? "5m");
  const [name, setName] = useState<string | null>(null);
  const [measure, setMeasure] = useState<"series" | "share">("series");
  const [fallback, setFallback] = useState<string | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [ticked, setTicked] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [preview, setPreview] = useState<MonitorPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState(() => serviceOfQuery(props.q));
  const [host, setHost] = useState("");
  const seenServices = useSeenServices(true);
  const n = Number(threshold);
  const nOk = Number.isFinite(n) && n > 0;
  const shownName = name ?? watchThisName(props.savedName, props.q, opensWhen, nOk ? n : 0, measure);
  const series = props.agg ? seriesLabel(props.agg).toLowerCase() : "rows of this search";

  useEffect(() => {
    void fetch("/api/settings")
      .then((res) => (res.ok ? (res.json() as Promise<{ default_webhook_url?: string | null }>) : null))
      .then((json) => {
        setFallback(json?.default_webhook_url ?? null);
        if (json?.default_webhook_url) {
          setTicked((t) => (t.length ? t : ["default"]));
        }
      })
      .catch(() => undefined);
    void fetch("/api/monitors")
      .then((res) => (res.ok ? (res.json() as Promise<{ monitors: Array<{ webhook_url: string | null; webhook_urls?: string[] | null }> }>) : null))
      .then((json) => json && setKnown(knownTargets(json.monitors)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!nOk) {
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q: props.q, threshold: String(n), opens_when: opensWhen, window: win, measure });
      if (props.agg && measure === "series") {
        params.set("agg", props.agg);
      }
      void fetch(`/api/monitors/preview?${params}`, { signal: ac.signal })
        .then((res) => (res.ok ? (res.json() as Promise<MonitorPreview>) : null))
        .then((body) => body && setPreview(body))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [props.q, props.agg, n, nOk, opensWhen, win, measure]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        props.onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const peak = useMemo(() => Math.max(nOk ? n * 1.25 : 1, ...(preview?.series.map((p) => p.v) ?? [1])), [preview, n, nOk]);
  const canSave = nOk && shownName.trim().length > 0 && ticked.length > 0 && serviceOk(service) && !busy;
  const toggle = (t: string) => setTicked((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t].slice(0, 5)));
  function addTarget() {
    const u = adding.trim();
    if (!/^https?:\/\//.test(u)) {
      toast.error("A webhook is an http(s) URL");
      return;
    }
    setKnown((k) => (k.includes(u) ? k : [...k, u]));
    setTicked((t) => (t.includes(u) ? t : [...t, u].slice(0, 5)));
    setAdding("");
  }

  async function save() {
    if (!canSave) {
      return;
    }
    setBusy(true);
    try {
      await props.onSave({ name: shownName.trim(), threshold: n, opensWhen, window: win, measure, webhookUrls: ticked, service: service.trim(), host: host.trim() });
    } catch {
      // the caller said why
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const urls = ticked.map((t) => (t === "default" ? fallback : t)).filter((u): u is string => Boolean(u));
    if (urls.length === 0) {
      toast.error("Tick a webhook to call");
      return;
    }
    for (const url of urls) {
      const res = await fetch("/api/alert-rules/test-call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: shownName, kind: "threshold", saved_search_id: props.savedId, threshold: n, opens_when: opensWhen, webhook_url: url, body_kind: "default", body_template: "" }),
      });
      toast[res.ok ? "success" : "error"](res.ok ? `Test call sent to ${callHost(url)}` : `Test call to ${callHost(url)} failed (${res.status})`);
    }
  }

  const lineY = 120 - Math.min(120, Math.round(((nOk ? n : 0) / peak) * 120));
  return (
    <section aria-label="Watch this" className="absolute inset-x-0 bottom-0 z-30 grid h-[470px] grid-cols-[minmax(0,1fr)_420px] gap-7 border-t border-zinc-700 bg-[#121214] px-7 py-[22px] shadow-[0_-24px_60px_rgba(0,0,0,.6)]">
      <form
        className="flex min-w-0 flex-col gap-[18px]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="m-0 text-[17px] font-semibold">Watch this hunt</h2>
          <span className="text-[12.5px] text-muted-foreground">Toposcope checks it every minute and opens a monitor while the condition holds.</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="watch-name" className="text-[12px] text-muted-foreground">
              Name
            </label>
            <input id="watch-name" value={shownName} onChange={(e) => setName(e.target.value)} className="h-[34px] w-[420px] max-w-full rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[13px] outline-none" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="watch-service" className="text-[12px] text-muted-foreground">
              Service *
            </label>
            <input id="watch-service" aria-required list="watch-services" value={service} placeholder={seenServices[0] ?? "api"} spellCheck={false} autoComplete="off" onChange={(e) => setService(e.target.value)} className="h-[34px] w-[160px] max-w-full rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
            <datalist id="watch-services">
              {seenServices.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="watch-host" className="text-[12px] text-muted-foreground">
              Host · optional
            </label>
            <input id="watch-host" value={host} placeholder="optional" spellCheck={false} autoComplete="off" onChange={(e) => setHost(e.target.value)} className="h-[34px] w-[160px] max-w-full rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Opens when</span>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded-[7px] border border-white/10 px-2.5 py-1.5">{series}</span>
            <span>{props.agg ? "is" : "are"}</span>
            <select aria-label="At least or fewer than" value={opensWhen} onChange={(e) => setOpensWhen(e.target.value as OpensWhen)} className="h-[32px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2 text-[13px]">
              <option value="at_least">at least</option>
              <option value="fewer_than">fewer than</option>
            </select>
            <input aria-label="Amount" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="h-[32px] w-[80px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2 text-right font-mono text-[13px] outline-none" />
            {props.agg ? null : (
              <select aria-label="Rows or a share of all rows" value={measure} onChange={(e) => setMeasure(e.target.value as "series" | "share")} className="h-[32px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2 text-[13px]">
                <option value="series">rows</option>
                <option value="share">% of all rows</option>
              </select>
            )}
            <span>in the last</span>
            {props.savedRange && !fixed ? (
              <span className="rounded-[7px] border border-white/10 px-2.5 py-1.5 font-mono">{props.savedRange}</span>
            ) : (
              <select aria-label="Window" value={win} disabled={Boolean(fixed)} onChange={(e) => setWin(e.target.value as PreviewWindow)} className="h-[32px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2 text-[13px] disabled:opacity-70">
                {windows.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            )}
          </div>
          <span className="text-[12px] text-muted-foreground">
            {props.savedName ? "The saved hunt's own window is the monitor's." : "Saving keeps this hunt as a saved hunt with that window."} Fewer than is for silence; a share of all rows holds however busy the instance is.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Sends to</span>
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[13px]">
            {fallback ? (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={ticked.includes("default")} onChange={() => toggle("default")} />
                the default webhook · {callHost(fallback)}
              </label>
            ) : null}
            {known.map((u) => (
              <label key={u} className="inline-flex max-w-[260px] items-center gap-2" title={u}>
                <input type="checkbox" checked={ticked.includes(u)} onChange={() => toggle(u)} />
                <span className="truncate">{targetLabel(u)}</span>
              </label>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <input
                aria-label="Another webhook URL"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTarget();
                  }
                }}
                placeholder="https://…"
                className="h-[30px] w-[220px] rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[12px] outline-none"
              />
              <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={addTarget}>
                + webhook
              </button>
            </span>
          </div>
          <span className="text-[12px] text-muted-foreground">Reminds every window while open · says when it resolves.</span>
        </div>
        <div className="mt-auto flex items-center gap-2.5">
          <span title={serviceOk(service) ? undefined : serviceMissing}>
            <Button type="submit" disabled={!canSave}>
              Save and watch
            </Button>
          </span>
          <Button type="button" variant="outline" disabled={!props.savedId} title={props.savedId ? undefined : "A test call reads a saved hunt: save this one first"} onClick={() => void sendTest()}>
            Send a test
          </Button>
          <Button type="button" variant="ghost" className="text-muted-foreground" onClick={props.onCancel}>
            Cancel
          </Button>
          {serviceOk(service) ? null : <span className="text-[12px] text-muted-foreground">{serviceMissing}</span>}
        </div>
      </form>
      <aside className="flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#0d0d0f] p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium">Would have opened · last 24 h</span>
          <span className="font-mono text-[12px] text-muted-foreground">
            {preview ? (preview.refused ? "cannot tell" : `${preview.opens.length} time${preview.opens.length === 1 ? "" : "s"} · ${Math.round(preview.open_ms / 60_000)} min open`) : "…"}
          </span>
        </div>
        <div className="relative h-[120px] border-b border-white/10">
          <div className="absolute inset-0 flex items-end gap-px">
            {(preview?.series ?? []).map((p) => (
              <div
                key={p.t}
                className={cn("min-w-0 flex-1", nOk && (opensWhen === "fewer_than" ? p.v < n : p.v >= n) ? "bg-[#c2410c]" : "bg-zinc-700")}
                style={{ height: `${Math.max(1, Math.round((p.v / peak) * 120))}px` }}
              />
            ))}
          </div>
          {nOk ? (
            <>
              <div className="absolute inset-x-0 border-t border-dashed border-plate" style={{ top: lineY }} />
              <span className="absolute right-0 bg-[#0d0d0f] px-1 font-mono text-[10.5px] text-plate" style={{ top: Math.max(0, lineY - 14) }}>
                {n}
              </span>
            </>
          ) : null}
        </div>
        <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground">
          <span>24 h ago</span>
          <span>now</span>
        </div>
        <div className="mt-1 flex flex-col gap-1 text-[12px] text-muted-foreground">
          {preview?.refused ? <span>{preview.refused}</span> : null}
          {(preview?.opens ?? []).slice(-3).reverse().map((o) => (
            <span key={o.from}>
              <span className={o.to ? "text-zinc-500" : "text-red-300"}>●</span> {o.from.slice(11, 16)} → {o.to ? o.to.slice(11, 16) : "now"}
            </span>
          ))}
        </div>
        {preview?.next ? (
          <span className="mt-auto text-[12px] text-muted-foreground">
            {opensWhen === "fewer_than" ? "Lower" : "Raise"} the threshold to {preview.next.threshold} and it would have opened {preview.next.opens === 0 ? "never" : preview.next.opens === 1 ? "once" : `${preview.next.opens} times`}.
          </span>
        ) : null}
      </aside>
    </section>
  );
}

