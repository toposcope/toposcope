import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  AddChip,
  box,
  btn,
  btn2,
  clock,
  ConditionsPanel,
  mmdd,
  resultsByLine,
  RunCallsRows,
  type RunCallsSet,
  type RunCallsState,
} from "@/components/check-editor-parts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { addLine, editorLines, goodLines, offeredTimeLimit, setTimeLimit, timeLine } from "@/http-editor";
import {
  nameFromTarget,
  netModeExample,
  netModeLabel,
  netModeOf,
  netModes,
  netSourceOf,
  netTimingBar,
  netTimingWords,
  offeredCertName,
  type NetMode,
} from "@/net-editor";
import type { MonitorView, NetSendResult } from "@/types";
import { alertBodyProblem, resolvedBodyProblem, type AlertBodyKind } from "../../shared/alert-body";
import { defaultFailAfter, defaultHttpEvery, formatCertShort, verdictSentence } from "../../shared/http-check";
import { defaultRemind, type RemindId } from "../../shared/monitor";
import { judgeNetRun, parseNetTarget, type NetSource, type Starttls } from "../../shared/net-check";

export type NetDraft = { mode: "create" } | { mode: "edit"; monitor: MonitorView };

/** What the editor sends to create or update a TCP or certificate monitor (#180). */
export type NetMonitorInput = {
  source: NetSource;
  name: string;
  /** host:port. */
  target: string;
  starttls: Starttls | null;
  every: string;
  fail_after: number;
  conditions: string;
  /** Null: the default webhook in Settings (#177). */
  webhook_url: string | null;
  body_kind: AlertBodyKind;
  body_template: string;
  resolved_body: string | null;
  remind_every: RemindId;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: NetDraft | null;
  /** "New monitor": back to choosing a source (18p). */
  onBack: () => void;
  onCreate: (input: NetMonitorInput) => Promise<void>;
  onUpdate: (id: string, input: NetMonitorInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  canLink: boolean;
};

const segColors: Record<string, string> = {
  dns: "#52525b",
  connect: "#71717a",
  starttls: "#38bdf8",
  tls: "#a1a1aa",
};

/**
 * The TCP · certificate editor (#180), as 18r draws the HTTP(S) one: where it connects, sent
 * once from this node, its lines picked from what answered and stored as text. TCP connects; TLS,
 * SMTP, IMAP and POP3 read the certificate, the last three after STARTTLS.
 */
export function NetMonitorDialog({ open, onOpenChange, draft, onBack, onCreate, onUpdate, onDelete, canLink }: Props) {
  const editing = draft?.mode === "edit" ? draft.monitor : null;
  const [mode, setMode] = useState<NetMode>("tcp");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [lines, setLines] = useState("");
  const [every, setEvery] = useState<string>(defaultHttpEvery);
  const [failAfter, setFailAfter] = useState<number>(defaultFailAfter);
  const [webhook, setWebhook] = useState("");
  const [remind, setRemind] = useState<RemindId>(defaultRemind);
  const [bodyKind, setBodyKind] = useState<AlertBodyKind>("default");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [resolvedBody, setResolvedBody] = useState("");
  const [open_, setOpen_] = useState<{ run: boolean; calls: boolean }>({ run: false, calls: false });
  const [result, setResult] = useState<NetSendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bar = useRef<HTMLSpanElement | null>(null);
  const dragSpan = useRef<number | null>(null);
  const webhookRef = useRef<HTMLInputElement | null>(null);
  const [askWebhook, setAskWebhook] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const { source, starttls } = netSourceOf(mode);
  const runCalls: RunCallsState = { name, every, failAfter, webhook, remind, bodyKind, bodyTemplate, resolvedBody };
  const setRunCall: RunCallsSet = {
    name: (v) => {
      setName(v);
      setNameTouched(true);
    },
    every: setEvery,
    failAfter: setFailAfter,
    webhook: setWebhook,
    remind: setRemind,
    bodyKind: setBodyKind,
    bodyTemplate: setBodyTemplate,
    resolvedBody: setResolvedBody,
  };

  useEffect(() => {
    if (askWebhook && open_.calls && webhookRef.current) {
      webhookRef.current.focus();
      setAskWebhook(false);
    }
  }, [askWebhook, open_.calls]);

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    void fetch("/api/settings")
      .then((res) => (res.ok ? (res.json() as Promise<{ default_webhook_url?: string | null }>) : null))
      .then((json) => setFallback(json?.default_webhook_url ?? null))
      .catch(() => undefined);
    setResult(null);
    setSendError(null);
    setProblem(null);
    setOpen_({ run: false, calls: false });
    if (draft.mode === "edit" && draft.monitor.net) {
      const m = draft.monitor;
      const n = m.net!;
      setMode(netModeOf(m.source === "cert" ? "cert" : "tcp", n.starttls));
      setTarget(n.target);
      setName(m.name);
      setNameTouched(true);
      setLines(n.conditions);
      setEvery(n.every);
      setFailAfter(n.fail_after);
      setWebhook(m.webhook_url ?? "");
      setRemind(m.remind_every && m.remind_every !== "window" ? m.remind_every : defaultRemind);
      setBodyKind(m.body_kind ?? "default");
      setBodyTemplate(m.body_template ?? "");
      setResolvedBody(m.resolved_body ?? "");
      return;
    }
    setMode("tcp");
    setTarget("");
    setName("");
    setNameTouched(false);
    setLines("");
    setEvery(defaultHttpEvery);
    setFailAfter(defaultFailAfter);
    setWebhook("");
    setRemind(defaultRemind);
    setBodyKind("default");
    setBodyTemplate("");
    setResolvedBody("");
  }, [open, draft]);

  const parsedTarget = target.trim() ? parseNetTarget(target) : null;
  const targetProblem = parsedTarget && "error" in parsedTarget ? parsedTarget.error : null;
  const rows = editorLines(lines, source);
  const good = goodLines(lines, source);
  const badLine = rows.find((r) => r.error);
  // A run read for the other kind (a TCP Send, then the mode set to TLS) is not judged.
  const run = result && result.source === source ? result : null;

  // What these lines make of the last run, judged here as they change.
  const verdict = useMemo(() => {
    if (!run) {
      return null;
    }
    const host = parseNetTarget(run.target);
    return judgeNetRun(
      source,
      good,
      run.error === null && !("error" in host)
        ? { host: host.host, seen: { durationMs: run.duration_ms, cert: run.cert } }
        : { error: run.error ?? "no answer" },
      Date.now(),
    );
  }, [run, good, source]);
  const lineResult = resultsByLine(lines, source, verdict?.lines ?? null);

  function pickMode(next: NetMode) {
    const was = netSourceOf(mode).source;
    setMode(next);
    // TCP and certificate lines are not the same lines: a switch starts them over.
    if (netSourceOf(next).source !== was) {
      setLines("");
      if (!nameTouched) {
        setName("");
      }
    }
  }

  async function send() {
    if (!target.trim() || targetProblem) {
      setSendError(targetProblem ?? "Give a host:port");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/monitors/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, target: target.trim(), starttls }),
      });
      const json = (await res.json().catch(() => null)) as (NetSendResult & { error?: string }) | null;
      if (!res.ok || !json || !("source" in json)) {
        setSendError(json?.error ?? `Send failed (${res.status})`);
        return;
      }
      setResult(json);
      if (!nameTouched) {
        setName(nameFromTarget(target, source));
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  function addPicked(line: string) {
    setLines((t) => addLine(t, line, source));
  }

  const bodyProblem = alertBodyProblem(bodyKind, bodyTemplate, "net");
  const resolvedProblem = resolvedBodyProblem(bodyKind, resolvedBody, "net");
  const fallbackName = nameFromTarget(target, source);

  function input(): NetMonitorInput | string {
    const n = (name.trim() || fallbackName).trim();
    if (!target.trim() || targetProblem) {
      return targetProblem ?? "Give a host:port to connect to";
    }
    if (!n) {
      return "Give it a name";
    }
    if (badLine) {
      return `Line ${badLine.index + 1}: ${badLine.error}`;
    }
    if (webhook.trim() && !/^https?:\/\//.test(webhook.trim())) {
      return "The webhook must be http(s); leave it empty for the default";
    }
    if (bodyProblem || resolvedProblem) {
      return (bodyProblem ?? resolvedProblem)!;
    }
    return {
      source,
      name: n,
      target: target.trim(),
      starttls,
      every,
      fail_after: failAfter,
      conditions: lines,
      webhook_url: webhook.trim() || null,
      body_kind: bodyKind,
      body_template: bodyTemplate,
      resolved_body: bodyKind === "default" || !resolvedBody.trim() ? null : resolvedBody,
      remind_every: remind,
    };
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const made = input();
    if (typeof made === "string") {
      setProblem(made);
      if (made.startsWith("The webhook")) {
        setOpen_((o) => ({ ...o, calls: true }));
        setAskWebhook(true);
      }
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      if (editing) {
        await onUpdate(editing.id, made);
      } else {
        await onCreate(made);
      }
      onOpenChange(false);
    } catch {
      // The toast says why; the editor stays open.
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
    } finally {
      setBusy(false);
    }
  }

  const limit = source === "tcp" ? timeLine(lines, "tcp") : null;
  const timing = run ? netTimingBar(run.timings, limit?.ms ?? null) : null;
  const certLeft = run?.cert ? Date.parse(run.cert.valid_to) - Date.now() : null;
  const certName = run?.cert ? offeredCertName(run.cert, run.target) : null;
  const sentence = verdict ? verdictSentence(verdict) : null;

  function onMarkerDown(e: React.PointerEvent<HTMLSpanElement>) {
    if (!timing) {
      return;
    }
    dragSpan.current = timing.spanMs;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onMarkerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const span = dragSpan.current;
    const el = bar.current;
    if (span === null || !el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0.01, (e.clientX - rect.left) / rect.width));
    setLines((t) => setTimeLimit(t, frac * span, "tcp"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(1080px,calc(100vw-32px))] overflow-y-auto rounded-[10px] border-white/12 bg-[#18181b] p-0">
        <form className="flex min-w-0 flex-col" onSubmit={(e) => void submit(e)}>
          <div className="flex min-w-0 items-center gap-2.5 border-b border-white/[0.08] px-[18px] py-3">
            {editing ? (
              <span className="shrink-0 text-[12.5px] text-muted-foreground">TCP · certificate</span>
            ) : (
              <button type="button" className="shrink-0 text-[12.5px] text-muted-foreground hover:text-foreground" onClick={onBack}>
                New monitor
              </button>
            )}
            <span className="text-muted-foreground">/</span>
            <DialogTitle className="m-0 min-w-0 truncate text-[15px] font-semibold">
              {editing ? editing.name : "TCP · certificate"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Toposcope connects to a port from this node on a schedule, or reads the certificate it answers with; conditions on
              what answered say ok, warn or fail.
            </DialogDescription>
            <select
              aria-label="Protocol"
              value={mode}
              // A monitor stays a TCP monitor or a certificate monitor once made.
              onChange={(e) => pickMode(e.target.value as NetMode)}
              className={cn(box, "ml-3 w-[76px] bg-transparent font-mono outline-none")}
            >
              {netModes
                .filter((m) => !editing || netSourceOf(m).source === (editing.source === "cert" ? "cert" : "tcp"))
                .map((m) => (
                  <option key={m} value={m}>
                    {netModeLabel[m]}
                  </option>
                ))}
            </select>
            <input
              aria-label="Host and port"
              value={target}
              autoFocus={!editing}
              placeholder={netModeExample[mode]}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
              className={cn(
                box,
                "min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted-foreground",
                targetProblem ? "border-red-400" : "",
              )}
            />
            <button type="button" className={btn2} disabled={sending || !target.trim()} onClick={() => void send()}>
              {sending ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              aria-label="Close"
              className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="grid min-h-[420px] grid-cols-1 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3 border-white/[0.08] px-4 py-3.5 md:border-r">
              <div className="flex items-center gap-2.5">
                <span className="text-[12px] font-semibold">Response</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  from this node{run ? ` · ${clock(run.at)}` : ""}
                </span>
              </div>
              {sendError ? <p className="text-[12.5px] text-red-300">{sendError}</p> : null}
              {!run ? (
                <p className="text-[12.5px] text-muted-foreground">
                  {source === "tcp"
                    ? "Send connects to it once from this node and shows whether the port took the connection, and where the time went."
                    : "Send connects to it once from this node, does the TLS handshake (after STARTTLS for SMTP, IMAP or POP3), and shows the certificate it answers with."}
                </p>
              ) : (
                <>
                  {run.connected ? (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="font-mono text-[13px]">connected</span>
                      <span className="font-mono text-muted-foreground">{run.address}</span>
                      {run.error ? <span className="min-w-0 truncate font-mono text-red-300">{run.error}</span> : null}
                      {source === "tcp" ? (
                        <span className="ml-auto">
                          <AddChip line="connected" onAdd={addPicked} />
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="font-mono text-[13px] text-red-300">No connection</span>
                      <span className="font-mono text-red-300">{run.error}</span>
                    </div>
                  )}

                  {timing && run.connected ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono">{run.duration_ms}ms</span>
                        <span className="text-muted-foreground">{netTimingWords(run.timings)}</span>
                        {source === "tcp" && !limit ? (
                          <span className="ml-auto">
                            <AddChip line={`time < ${offeredTimeLimit(run.duration_ms)}ms`} onAdd={addPicked} />
                          </span>
                        ) : null}
                      </span>
                      <span ref={bar} className="relative block h-[30px]">
                        <span className="absolute inset-x-0 top-2.5 flex h-2.5 overflow-hidden rounded-[3px] bg-[#0f0f11]">
                          {timing.segments.map((seg) => (
                            <span
                              key={seg.id}
                              title={`${seg.id} ${Math.round(seg.ms)}ms`}
                              style={{ width: `${(seg.frac * 100).toFixed(2)}%`, background: segColors[seg.id] }}
                            />
                          ))}
                        </span>
                        {limit && timing.marker !== null ? (
                          <span
                            role="slider"
                            aria-label="Time limit"
                            aria-valuenow={limit.ms}
                            aria-valuemin={10}
                            aria-valuemax={Math.round(timing.spanMs)}
                            tabIndex={0}
                            onPointerDown={onMarkerDown}
                            onPointerMove={onMarkerMove}
                            onPointerUp={() => {
                              dragSpan.current = null;
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                                e.preventDefault();
                                setLines((t) => setTimeLimit(t, limit.ms + (e.key === "ArrowLeft" ? -10 : 10), "tcp"));
                              }
                            }}
                            className="absolute top-0.5 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
                            style={{ left: `${(timing.marker * 100).toFixed(2)}%` }}
                          >
                            <span className="absolute inset-y-0 left-1/2 border-l-2 border-[#fcd34d]" />
                            <span
                              className={cn(
                                "absolute -top-1.5 font-mono text-[10.5px] whitespace-nowrap text-[#fcd34d]",
                                timing.marker > 0.8 ? "right-[calc(50%+6px)]" : "left-[calc(50%+6px)]",
                              )}
                            >
                              {limit.ms}ms, drag
                            </span>
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}

                  {run.cert ? (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="text-muted-foreground">certificate</span>
                      <span className="min-w-0 truncate font-mono">
                        {run.cert.subject || run.cert.names[0] || "—"} · expires {mmdd(run.cert.valid_to)} ·{" "}
                        {certLeft !== null ? formatCertShort(certLeft) : "—"}
                      </span>
                      <span className="ml-auto flex shrink-0 gap-1">
                        <AddChip line="cert > 14d" onAdd={addPicked} />
                        {certName ? <AddChip line={certName} onAdd={addPicked} /> : null}
                      </span>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2.5 px-4 py-3.5">
              <ConditionsPanel
                kind={source}
                lines={lines}
                setLines={setLines}
                results={lineResult}
                none={source === "tcp" ? "connecting passes" : "a trusted certificate for this host passes"}
              />

              <RunCallsRows
                state={runCalls}
                set={setRunCall}
                namePlaceholder={fallbackName || (source === "tcp" ? "db:5432" : "smtp certificate")}
                open={open_}
                onToggle={(which) => setOpen_((o) => ({ ...o, [which]: !o[which] }))}
                webhookRef={webhookRef}
                fallback={fallback}
                alertKind="net"
                preview={{
                  name: name.trim() || fallbackName,
                  query: `${source} ${target.trim()}${starttls ? ` starttls ${starttls}` : ""}`,
                  series: verdict?.why ?? "",
                }}
                canLink={canLink}
                testDraft={() =>
                  (/^https?:\/\//.test(webhook.trim()) || (!webhook.trim() && fallback)) && !bodyProblem
                    ? {
                        source,
                        id: editing?.id,
                        name: name.trim() || fallbackName,
                        target: target.trim(),
                        starttls,
                        webhook_url: webhook.trim() || null,
                        body_kind: bodyKind,
                        body_template: bodyTemplate,
                        resolved_body: bodyKind === "default" || !resolvedBody.trim() ? null : resolvedBody,
                        run: run
                          ? { duration_ms: run.duration_ms, why: verdict?.why ?? null, cert_valid_to: run.cert?.valid_to ?? null }
                          : null,
                      }
                    : null
                }
              />
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-white/[0.08] px-[18px] py-3">
            <span role="status" className={cn("min-w-0 text-[12px]", problem ? "text-red-300" : "text-muted-foreground")}>
              {problem ? (
                problem
              ) : sending ? (
                "Sending from this node…"
              ) : sentence ? (
                <>
                  With these, the last run would{" "}
                  <span
                    className={
                      sentence.word === "pass" ? "text-[#7dd3fc]" : sentence.word === "warn" ? "text-[#fcd34d]" : "text-[#fca5a5]"
                    }
                  >
                    {sentence.word}
                  </span>
                  {sentence.rest}
                </>
              ) : (
                "Send it to see what these lines make of what answers."
              )}
            </span>
            <span className="ml-auto flex shrink-0 gap-2">
              {editing ? (
                <button type="button" className={cn(btn2, "border-transparent text-red-300")} disabled={busy} onClick={() => void remove()}>
                  Delete
                </button>
              ) : null}
              <button type="button" className={btn2} onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className={btn} disabled={busy}>
                {editing ? "Save" : "Create"}
              </button>
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
