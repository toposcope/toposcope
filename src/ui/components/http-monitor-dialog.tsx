import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { AlertBodyField } from "@/components/alert-body-field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  addLine,
  bodyContains,
  editorLines,
  formatBytes,
  goodLines,
  headerContains,
  headersText,
  jsonRows,
  nameFromUrl,
  offeredLines,
  offeredTimeLimit,
  readHeadersText,
  removeLine,
  setLineLevel,
  setTimeLimit,
  timeLine,
  timingBar,
  timingWords,
  webhookShort,
  type JsonRow,
} from "@/http-editor";
import type { HttpSendResult, MonitorView } from "@/types";
import { alertBodyProblem, resolvedBodyProblem, type AlertBodyKind } from "../../shared/alert-body";
import {
  defaultFailAfter,
  defaultHttpEvery,
  formatCertShort,
  httpEveryIds,
  httpMethods,
  httpUrlProblem,
  judgeRun,
  verdictSentence,
  type HttpMethod,
  type LineResult,
} from "../../shared/http-check";
import { defaultRemind, type RemindId } from "../../shared/monitor";

export type HttpDraft = { mode: "create" } | { mode: "edit"; monitor: MonitorView };

/** What the editor sends to create or update an HTTP(S) monitor. */
export type HttpMonitorInput = {
  source: "http";
  name: string;
  url: string;
  method: HttpMethod;
  body: string | null;
  /** A null value keeps the one stored under that name. */
  headers: Record<string, string | null>;
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
  draft: HttpDraft | null;
  /** "New monitor": back to choosing a source (18p). */
  onBack: () => void;
  onCreate: (input: HttpMonitorInput) => Promise<void>;
  onUpdate: (id: string, input: HttpMonitorInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  canLink: boolean;
};

const box = "box-border flex min-h-[30px] items-center gap-2 rounded-[6px] border border-white/15 px-2.5 py-[5px] text-[13px]";
const btn2 = "h-[30px] rounded-[6px] border border-white/15 bg-transparent px-3 text-[13px] text-foreground hover:bg-accent disabled:opacity-50";
const btn = "h-[30px] rounded-[6px] bg-[#e4e4e7] px-3.5 text-[13px] font-medium text-[#18181b] hover:bg-white disabled:opacity-50";
const add =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border border-dashed border-[rgba(231,225,211,.6)] bg-transparent px-[7px] text-[11px] whitespace-nowrap text-[#e7e1d3] hover:bg-[rgba(231,225,211,.08)]";
const segColors: Record<string, string> = {
  dns: "#52525b",
  connect: "#71717a",
  tls: "#a1a1aa",
  wait: "#38bdf8",
  body: "#e7e1d3",
};
const remindIds = ["off", "1h", "4h", "24h"] as const;
const failAfterIds = [1, 2, 3, 5] as const;

function AddChip({ line, label, onAdd }: { line: string; label?: string; onAdd: (line: string) => void }) {
  return (
    <button
      type="button"
      className={add}
      title={line}
      onClick={(e) => {
        e.stopPropagation();
        onAdd(line);
      }}
    >
      + {label ?? line}
    </button>
  );
}

function Seg<T extends string | number>({
  label,
  ids,
  value,
  onPick,
  text,
}: {
  label: string;
  ids: readonly T[];
  value: T;
  onPick: (id: T) => void;
  text?: (id: T) => string;
}) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex h-7 overflow-hidden rounded-[6.4px] border border-white/15">
      {ids.map((id) => (
        <button
          key={String(id)}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onPick(id)}
          className={
            value === id
              ? "bg-accent px-2.5 text-[12px] text-foreground"
              : "px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
          }
        >
          {text ? text(id) : String(id)}
        </button>
      ))}
    </span>
  );
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function mmdd(iso: string): string {
  return iso.slice(5, 10);
}

function jsonValue(v: JsonRow["value"]): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** Frame 18r: an HTTP(S) monitor, its conditions picked from the live response and stored as lines. */
export function HttpMonitorDialog({ open, onOpenChange, draft, onBack, onCreate, onUpdate, onDelete, canLink }: Props) {
  const editing = draft?.mode === "edit" ? draft.monitor : null;
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("");
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
  const [reqHeaders, setReqHeaders] = useState("");
  const [reqBody, setReqBody] = useState("");
  const [open_, setOpen_] = useState<{ run: boolean; calls: boolean; request: boolean }>({ run: false, calls: false, request: false });
  const [result, setResult] = useState<HttpSendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [allHeaders, setAllHeaders] = useState(false);
  const bar = useRef<HTMLSpanElement | null>(null);
  const dragSpan = useRef<number | null>(null);
  const webhookRef = useRef<HTMLInputElement | null>(null);
  /** A webhook that is not one opens calls and puts the caret in it, once it is drawn. */
  const [askWebhook, setAskWebhook] = useState(false);
  /** The default webhook in Settings, which it calls without one of its own (18r: `default · …`). */
  const [fallback, setFallback] = useState<string | null>(null);

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
    setHover(null);
    setAllHeaders(false);
    if (draft.mode === "edit" && draft.monitor.http) {
      const m = draft.monitor;
      const h = m.http!;
      setMethod(h.method);
      setUrl(h.url);
      setName(m.name);
      setNameTouched(true);
      setLines(h.conditions);
      setEvery(h.every);
      setFailAfter(h.fail_after);
      setWebhook(m.webhook_url ?? "");
      setRemind(m.remind_every && m.remind_every !== "window" ? m.remind_every : defaultRemind);
      setBodyKind(m.body_kind ?? "default");
      setBodyTemplate(m.body_template ?? "");
      setResolvedBody(m.resolved_body ?? "");
      setReqHeaders(headersText(h.headers));
      setReqBody(h.body ?? "");
      setOpen_({ run: false, calls: false, request: false });
      return;
    }
    setMethod("GET");
    setUrl("");
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
    setReqHeaders("");
    setReqBody("");
    setOpen_({ run: false, calls: false, request: false });
  }, [open, draft]);

  const urlProblem = url.trim() ? httpUrlProblem(url) : null;
  const headersRead = readHeadersText(reqHeaders);
  const headers = headersRead.ok ? headersRead.headers : {};
  const headersError = headersRead.ok ? null : headersRead.error;
  const rows = editorLines(lines);
  const good = goodLines(lines);
  const badLine = rows.find((r) => r.error);

  // What these lines make of the last response, judged here as they change.
  const verdict = useMemo(() => {
    if (!result) {
      return null;
    }
    return judgeRun(
      good,
      result.response
        ? {
            url: result.url,
            seen: {
              status: result.response.status,
              headers: result.response.headers,
              body: result.response.body,
              durationMs: result.duration_ms,
              https: result.url.startsWith("https:"),
              certValidTo: result.cert?.valid_to ?? null,
            },
          }
        : { error: result.error ?? "no response" },
      Date.now(),
    );
  }, [result, good]);
  const lineResult = new Map<number, LineResult>();
  if (verdict) {
    let k = 0;
    for (const r of rows) {
      if (r.line) {
        lineResult.set(r.index, verdict.lines[k++]!);
      }
    }
  }

  async function send() {
    if (!url.trim() || urlProblem || headersError) {
      setSendError(urlProblem ?? headersError ?? "Give a URL");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/monitors/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          url: url.trim(),
          method,
          headers,
          body: method === "POST" ? reqBody : null,
        }),
      });
      const json = (await res.json().catch(() => null)) as (HttpSendResult & { error?: string }) | null;
      if (!res.ok || !json) {
        setSendError(json?.error ?? `Send failed (${res.status})`);
        return;
      }
      setResult(json);
      if (!nameTouched) {
        setName(nameFromUrl(url));
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  function addPicked(line: string) {
    setLines((t) => addLine(t, line));
  }

  const bodyProblem = alertBodyProblem(bodyKind, bodyTemplate, "http");
  const resolvedProblem = resolvedBodyProblem(bodyKind, resolvedBody, "http");

  function input(): HttpMonitorInput | string {
    const n = (name.trim() || nameFromUrl(url)).trim();
    if (!url.trim() || urlProblem) {
      return urlProblem ?? "Give a URL to call";
    }
    if (!n) {
      return "Give it a name";
    }
    if (badLine) {
      return `Line ${badLine.index + 1}: ${badLine.error}`;
    }
    if (headersError) {
      return headersError;
    }
    if (webhook.trim() && !/^https?:\/\//.test(webhook.trim())) {
      return "The webhook must be http(s); leave it empty for the default";
    }
    if (bodyProblem || resolvedProblem) {
      return (bodyProblem ?? resolvedProblem)!;
    }
    return {
      source: "http",
      name: n,
      url: url.trim(),
      method,
      body: method === "POST" && reqBody ? reqBody : null,
      headers,
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

  const response = result?.response ?? null;
  const limit = timeLine(lines);
  const timing = result ? timingBar(result.timings, limit?.ms ?? null) : null;
  const doc = useMemo(() => {
    const text = response?.body.trim() ?? "";
    if (!text || (text[0] !== "{" && text[0] !== "[")) {
      return null;
    }
    try {
      return { rows: jsonRows(JSON.parse(text) as unknown) };
    } catch {
      return null;
    }
  }, [response]);
  const textLines = useMemo(() => (response && !doc ? response.body.split("\n").slice(0, 200) : []), [response, doc]);
  const shownHeader =
    response?.headers.find(([k]) => k === "content-type") ?? response?.headers[0] ?? null;
  const certLeft = result?.cert ? Date.parse(result.cert.valid_to) - Date.now() : null;
  const sentence = verdict ? verdictSentence(verdict) : null;
  const headerCount = Object.keys(headers).length;

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
    setLines((t) => setTimeLimit(t, frac * span));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(1080px,calc(100vw-32px))] overflow-y-auto rounded-[10px] border-white/12 bg-[#18181b] p-0">
        <form className="flex min-w-0 flex-col" onSubmit={(e) => void submit(e)}>
          <div className="flex min-w-0 items-center gap-2.5 border-b border-white/[0.08] px-[18px] py-3">
            {editing ? (
              <span className="shrink-0 text-[12.5px] text-muted-foreground">HTTP(S)</span>
            ) : (
              <button type="button" className="shrink-0 text-[12.5px] text-muted-foreground hover:text-foreground" onClick={onBack}>
                New monitor
              </button>
            )}
            <span className="text-muted-foreground">/</span>
            <DialogTitle className="m-0 min-w-0 truncate text-[15px] font-semibold">
              {editing ? editing.name : "HTTP(S)"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Toposcope calls a URL from this node on a schedule; conditions on its response say ok, warn or fail.
            </DialogDescription>
            <select
              aria-label="Method"
              value={method}
              onChange={(e) => setMethod(e.target.value as HttpMethod)}
              className={cn(box, "ml-3 w-[76px] bg-transparent font-mono outline-none")}
            >
              {httpMethods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              aria-label="URL"
              value={url}
              autoFocus={!editing}
              placeholder="https://api.example.com/health"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
              className={cn(
                box,
                "min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted-foreground",
                urlProblem ? "border-red-400" : "",
              )}
            />
            <button type="button" className={btn2} disabled={sending || !url.trim()} onClick={() => void send()}>
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

          <div className="grid min-h-[520px] grid-cols-1 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3 border-white/[0.08] px-4 py-3.5 md:border-r">
              <div className="flex items-center gap-2.5">
                <span className="text-[12px] font-semibold">Response</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  from this node{result ? ` · ${clock(result.at)}` : ""}
                </span>
              </div>
              {sendError ? <p className="text-[12.5px] text-red-300">{sendError}</p> : null}
              {!result ? (
                <p className="text-[12.5px] text-muted-foreground">
                  Send calls it once from this node and shows what came back: the status, where the time went, the
                  certificate, the headers and the body.
                </p>
              ) : (
                <>
                  {response ? (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="font-mono text-[13px]">
                        {response.status} {response.status_text}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {response.http_version} · {formatBytes(response.body_bytes)}
                        {response.truncated ? " · first 1 MB" : ""}
                      </span>
                      <span className="ml-auto">
                        <AddChip line={`status == ${response.status}`} onAdd={addPicked} />
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="font-mono text-[13px] text-red-300">No response</span>
                      <span className="font-mono text-red-300">{result.error}</span>
                    </div>
                  )}

                  {timing ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono">{result.duration_ms}ms</span>
                        <span className="text-muted-foreground">{timingWords(result.timings)}</span>
                        {response && !limit ? (
                          <span className="ml-auto">
                            <AddChip line={`time < ${offeredTimeLimit(result.duration_ms)}ms`} onAdd={addPicked} />
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
                                setLines((t) => setTimeLimit(t, limit.ms + (e.key === "ArrowLeft" ? -10 : 10)));
                              }
                            }}
                            className="absolute top-0.5 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
                            style={{ left: `${(timing.marker * 100).toFixed(2)}%` }}
                          >
                            <span className="absolute inset-y-0 left-1/2 border-l-2 border-[#fcd34d]" />
                            <span
                              className={cn(
                                "absolute -top-1.5 font-mono text-[10.5px] whitespace-nowrap text-[#fcd34d]",
                                // Near the bar's end the words sit on the marker's left.
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

                  {result.cert ? (
                    <div className="flex items-center gap-2.5 text-[12.5px]">
                      <span className="text-muted-foreground">certificate</span>
                      <span className="min-w-0 truncate font-mono">
                        {result.cert.subject || new URL(result.url).hostname} · expires {mmdd(result.cert.valid_to)} ·{" "}
                        {certLeft !== null ? formatCertShort(certLeft) : "—"}
                      </span>
                      <span className="ml-auto">
                        <AddChip line="cert > 14d" onAdd={addPicked} />
                      </span>
                    </div>
                  ) : null}

                  {response && shownHeader ? (
                    <div className="flex flex-col gap-1 text-[12.5px]">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="text-muted-foreground">headers</span>
                        <button
                          type="button"
                          className="min-w-0 truncate text-left font-mono text-muted-foreground hover:text-foreground"
                          title={headerContains(shownHeader[0], shownHeader[1]) ?? undefined}
                          onClick={() => {
                            const line = headerContains(shownHeader[0], shownHeader[1]);
                            if (line) addPicked(line);
                          }}
                        >
                          {shownHeader[0]}: {shownHeader[1]}
                        </button>
                        {response.headers.length > 1 ? (
                          <button
                            type="button"
                            aria-expanded={allHeaders}
                            className="shrink-0 font-mono text-muted-foreground hover:text-foreground"
                            onClick={() => setAllHeaders((v) => !v)}
                          >
                            · {allHeaders ? "fewer" : `${response.headers.length - 1} more`}
                          </button>
                        ) : null}
                      </div>
                      {allHeaders
                        ? response.headers
                            .filter((h) => h !== shownHeader)
                            .map(([k, v], i) => (
                              <button
                                key={`${k}-${i}`}
                                type="button"
                                className="truncate pl-[58px] text-left font-mono text-[12px] text-muted-foreground hover:text-foreground"
                                title={headerContains(k, v) ?? undefined}
                                onClick={() => {
                                  const line = headerContains(k, v);
                                  if (line) addPicked(line);
                                }}
                              >
                                {k}: {v}
                              </button>
                            ))
                        : null}
                    </div>
                  ) : null}

                  {response && (doc || textLines.some((l) => l.trim())) ? (
                    <div className="relative max-h-[340px] overflow-auto rounded-[6px] border border-white/10 bg-[#0f0f11] py-1.5">
                      {doc
                        ? doc.rows.map((row, i) => {
                            const offers = row.path && row.value !== undefined ? offeredLines(row.path, row.value) : [];
                            const on = hover === i && offers.length > 0;
                            return (
                              <div
                                key={i}
                                {...(offers.length > 0
                                  ? {
                                      role: "button",
                                      tabIndex: 0,
                                      "aria-label": `Add ${offers[0]}`,
                                      onFocus: () => setHover(i),
                                      onKeyDown: (e: React.KeyboardEvent) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          addPicked(offers[0]!);
                                        }
                                      },
                                    }
                                  : {})}
                                onMouseEnter={() => setHover(i)}
                                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                                onClick={() => (offers[0] ? addPicked(offers[0]) : undefined)}
                                className={cn(
                                  "flex h-6 items-center gap-1.5 px-2.5 font-mono text-[12.5px] outline-none",
                                  offers.length > 0 ? "cursor-pointer" : "",
                                  on ? "bg-[rgba(231,225,211,.08)] outline-1 -outline-offset-1 outline-[rgba(231,225,211,.35)]" : "",
                                )}
                                style={{ paddingLeft: 10 + (row.depth > 0 ? 16 + 18 * (row.depth - 1) : 0) }}
                              >
                                {row.key !== null ? (
                                  <>
                                    <span className="text-[#7dd3fc]">{JSON.stringify(row.key)}</span>
                                    <span className="text-muted-foreground">:</span>
                                  </>
                                ) : null}
                                {row.brace ? (
                                  <span className="text-muted-foreground">
                                    {row.brace}
                                    {row.comma ? "," : ""}
                                  </span>
                                ) : (
                                  <>
                                    <span className="truncate text-[#e4e4e7]">{jsonValue(row.value)}</span>
                                    {row.comma ? <span className="text-muted-foreground">,</span> : null}
                                  </>
                                )}
                                {on ? (
                                  <span className="ml-auto flex gap-1">
                                    <AddChip line={offers[0]!} onAdd={addPicked} />
                                    {offers.slice(1).map((o) => (
                                      <AddChip key={o} line={o} label={o.includes(" < ") ? "<" : ">"} onAdd={addPicked} />
                                    ))}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })
                        : textLines.map((l, i) => {
                            const offer = bodyContains(l);
                            const on = hover === i && offer !== null;
                            return (
                              <div
                                key={i}
                                {...(offer
                                  ? {
                                      role: "button",
                                      tabIndex: 0,
                                      "aria-label": `Add ${offer}`,
                                      onFocus: () => setHover(i),
                                      onKeyDown: (e: React.KeyboardEvent) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          addPicked(offer);
                                        }
                                      },
                                    }
                                  : {})}
                                onMouseEnter={() => setHover(i)}
                                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                                onClick={() => (offer ? addPicked(offer) : undefined)}
                                className={cn(
                                  "flex min-h-6 items-center gap-1.5 px-2.5 font-mono text-[12.5px] outline-none",
                                  offer ? "cursor-pointer" : "",
                                  on ? "bg-[rgba(231,225,211,.08)] outline-1 -outline-offset-1 outline-[rgba(231,225,211,.35)]" : "",
                                )}
                              >
                                <span className="min-w-0 truncate whitespace-pre text-[#e4e4e7]">{l || " "}</span>
                                {on ? (
                                  <span className="ml-auto">
                                    <AddChip line={offer!} onAdd={addPicked} />
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                    </div>
                  ) : null}
                  {response ? (
                    <span className="text-[11.5px] text-muted-foreground">
                      Click a value to make it a condition. A number offers == , &lt; and &gt;.
                    </span>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold">Conditions</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  {good.length > 0 ? `${good.length} · all must pass` : "none · any 2xx passes"}
                </span>
              </div>
              {rows.map((row) => {
                const r = lineResult.get(row.index);
                const level = row.line?.level ?? "fail";
                const tone =
                  !r || r.pass === null
                    ? "text-muted-foreground"
                    : r.pass
                      ? "text-[#7dd3fc]"
                      : level === "warn"
                        ? "text-[#fcd34d]"
                        : "text-[#fca5a5]";
                return (
                  <div
                    key={`${row.index}-${row.raw}`}
                    data-line={row.index}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto_22px] items-center gap-2 rounded-[6px] border bg-[#0f0f11] px-2.5 py-[7px] text-[12.5px]",
                      row.error ? "border-red-400/50" : "border-white/[0.08]",
                    )}
                  >
                    <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                      {row.line ? row.line.text : row.raw.trim()}{" "}
                      {r ? (
                        <span className={tone} title={r.why ?? undefined}>
                          {r.pass === null ? "—" : `${r.pass ? "✓" : "✗"} ${r.got}`}
                        </span>
                      ) : null}
                      {row.error ? <span className="block font-sans text-[11.5px] text-red-300">{row.error}</span> : null}
                    </span>
                    {row.line ? (
                      <span className="inline-flex rounded-[5px] border border-white/12 p-px">
                        {(["fail", "warn"] as const).map((lv) => (
                          <button
                            key={lv}
                            type="button"
                            aria-pressed={level === lv}
                            onClick={() => setLines((t) => setLineLevel(t, row.index, lv))}
                            className={cn(
                              "rounded-[4px] px-1.5 py-px text-[10.5px]",
                              level === lv ? "bg-[#27272a] text-foreground" : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {lv}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      aria-label="Remove"
                      className="text-[14px] text-muted-foreground hover:text-foreground"
                      onClick={() => setLines((t) => removeLine(t, row.index))}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <label className="mt-1 flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">Stored as lines</span>
                <textarea
                  aria-label="Stored as lines"
                  value={lines}
                  spellCheck={false}
                  rows={Math.max(4, lines.split("\n").length + 1)}
                  onChange={(e) => setLines(e.target.value)}
                  className="resize-y rounded-[5px] border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-[#d4d4d8] outline-none"
                />
              </label>

              <div className="mt-auto flex flex-col gap-1.5 border-t border-white/[0.08] pt-2.5">
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 shrink-0 text-muted-foreground">name</span>
                  <input
                    aria-label="Name"
                    value={name}
                    placeholder={nameFromUrl(url) || "api /health"}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(true);
                    }}
                    className={cn(box, "min-h-7 flex-1 bg-transparent outline-none placeholder:text-muted-foreground")}
                  />
                </span>
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 shrink-0 text-muted-foreground">run</span>
                  <span className="min-w-0 truncate font-mono">
                    every {every} · open after {failAfter} failed run{failAfter === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    aria-expanded={open_.run}
                    className="ml-auto shrink-0 hover:underline"
                    onClick={() => setOpen_((o) => ({ ...o, run: !o.run }))}
                  >
                    {open_.run ? "Done" : "Change"}
                  </button>
                </span>
                {open_.run ? (
                  <span className="flex flex-wrap items-center gap-2 rounded-[6px] border border-white/10 bg-[#0f0f11] p-2.5 text-[12px] text-muted-foreground">
                    every
                    <Seg label="Every" ids={httpEveryIds} value={every as (typeof httpEveryIds)[number]} onPick={setEvery} />
                    open after
                    <Seg label="Open after" ids={failAfterIds} value={failAfter as (typeof failAfterIds)[number]} onPick={setFailAfter} />
                    failed runs
                  </span>
                ) : null}
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 shrink-0 text-muted-foreground">calls</span>
                  <span className={cn("min-w-0 truncate font-mono", webhook.trim() || fallback ? "" : "text-muted-foreground")}>
                    {webhook.trim()
                      ? webhookShort(webhook)
                      : fallback
                        ? `default · ${webhookShort(fallback)}`
                        : "nobody: no default webhook in Settings"}{" "}
                    ·{" "}
                    {remind === "off" ? "no reminders" : `remind ${remind}`}
                    {bodyKind !== "default" ? ` · ${bodyKind} body` : ""}
                  </span>
                  <button
                    type="button"
                    aria-expanded={open_.calls}
                    className="ml-auto shrink-0 hover:underline"
                    onClick={() => setOpen_((o) => ({ ...o, calls: !o.calls }))}
                  >
                    {open_.calls ? "Done" : "Change"}
                  </button>
                </span>
                {open_.calls ? (
                  <div className="flex flex-col gap-3 rounded-[6px] border border-white/10 bg-[#0f0f11] p-2.5">
                    <span className="flex items-center gap-2 text-[12px]">
                      <span className="w-[58px] shrink-0 text-muted-foreground">webhook</span>
                      <input
                        ref={webhookRef}
                        aria-label="Webhook"
                        value={webhook}
                        onChange={(e) => setWebhook(e.target.value)}
                        placeholder={fallback ? `empty: the default, ${webhookShort(fallback)}` : "https://ntfy.sh/… or https://hooks.slack.com/services/…"}
                        className={cn(box, "min-h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground")}
                      />
                    </span>
                    <span className="pl-[66px] text-[11px] text-muted-foreground">
                      Left empty, it calls the default webhook, set in Settings for any monitor without its own.
                    </span>
                    <span className="flex items-center gap-2 text-[12px]">
                      <span className="w-[58px] shrink-0 text-muted-foreground">remind</span>
                      <Seg label="Remind" ids={remindIds} value={remind as (typeof remindIds)[number]} onPick={setRemind} />
                    </span>
                    <AlertBodyField
                      alertKind="http"
                      bodyKind={bodyKind}
                      onBodyKind={setBodyKind}
                      template={bodyTemplate}
                      onTemplate={setBodyTemplate}
                      resolvedBody={resolvedBody}
                      onResolvedBody={setResolvedBody}
                      webhook={webhook.trim() || fallback || ""}
                      preview={{
                        name: name.trim() || nameFromUrl(url),
                        query: `${method} ${url.trim()}`,
                        series: verdict?.why ?? "",
                        value: null,
                        threshold: "",
                      }}
                      canLink={canLink}
                      testDraft={() =>
                        (/^https?:\/\//.test(webhook.trim()) || (!webhook.trim() && fallback)) && !bodyProblem
                          ? {
                              source: "http",
                              id: editing?.id,
                              name: name.trim() || nameFromUrl(url),
                              url: url.trim(),
                              method,
                              webhook_url: webhook.trim() || null,
                              body_kind: bodyKind,
                              body_template: bodyTemplate,
                              resolved_body: bodyKind === "default" || !resolvedBody.trim() ? null : resolvedBody,
                              run: result
                                ? { status: result.response?.status ?? null, duration_ms: result.duration_ms, why: verdict?.why ?? null }
                                : null,
                            }
                          : null
                      }
                    />
                  </div>
                ) : null}
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 shrink-0 text-muted-foreground">request</span>
                  <span className="min-w-0 truncate font-mono">
                    {headerCount === 0 ? "no headers" : `${headerCount} header${headerCount === 1 ? "" : "s"}`} ·{" "}
                    {method === "POST" && reqBody ? "a body" : "no body"}
                  </span>
                  <button
                    type="button"
                    aria-expanded={open_.request}
                    className="ml-auto shrink-0 hover:underline"
                    onClick={() => setOpen_((o) => ({ ...o, request: !o.request }))}
                  >
                    {open_.request ? "Done" : "Change"}
                  </button>
                </span>
                {open_.request ? (
                  // 18v: the request's headers, and the body a POST sends.
                  <div className="flex flex-col gap-1.5 rounded-[6px] border border-white/10 bg-[#0f0f11] p-2.5">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[11px] text-muted-foreground">headers · Name: value, one a line</span>
                      <textarea
                        aria-label="Headers"
                        value={reqHeaders}
                        spellCheck={false}
                        rows={Math.max(2, reqHeaders.split("\n").length)}
                        placeholder="Authorization: Bearer …"
                        onChange={(e) => setReqHeaders(e.target.value)}
                        className={cn(
                          "resize-y rounded-[5px] border bg-transparent px-[9px] py-[7px] font-mono text-[12px] leading-[1.6] outline-none placeholder:text-muted-foreground/60",
                          headersError ? "border-red-400" : "border-white/15",
                        )}
                      />
                    </label>
                    {headersError ? (
                      <span className="text-[11px] text-red-300">{headersError}</span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        A saved value shows as •••• and is kept unless you type over it.
                      </span>
                    )}
                    {method === "POST" ? (
                      <label className="mt-1 flex flex-col gap-1.5">
                        <span className="text-[11px] text-muted-foreground">body · sent with POST</span>
                        <textarea
                          aria-label="Body"
                          value={reqBody}
                          spellCheck={false}
                          rows={Math.max(1, reqBody.split("\n").length)}
                          onChange={(e) => setReqBody(e.target.value)}
                          className="resize-y rounded-[5px] border border-white/15 bg-transparent px-[9px] py-[7px] font-mono text-[12px] leading-[1.6] outline-none"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
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
                  With these, the last response would{" "}
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
                "Send it to see what these lines make of the response."
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
