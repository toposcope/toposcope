import { useEffect, useRef, useState } from "react";
import { CircleAlert, Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MonitorField, MonitorSwitch } from "@/components/monitor-field";
import {
  alertBodyContentType,
  alertBodyProblem,
  alertFillIns,
  checkJsonBody,
  resolvedBodyProblem,
  starterAlertBody,
  type AlertBodyKind,
  type FillInKind,
} from "../../shared/alert-body";

/** What the server said about a test call (`POST /api/alert-rules/test-call`). */
export type TestCallResult = {
  ok: boolean;
  status: number | null;
  status_text: string;
  ms: number;
  at: string;
  reply: string;
  sent: string;
  content_type: string;
  /** The resolved body, sent after the open one when there is one (18t). */
  resolved?: Omit<TestCallResult, "resolved"> | null;
};

type Props = {
  /** Whose fill-ins: a search monitor's, a new-fingerprints alert's, or an HTTP(S) monitor's (#178). */
  alertKind: FillInKind;
  bodyKind: AlertBodyKind;
  onBodyKind: (kind: AlertBodyKind) => void;
  template: string;
  onTemplate: (template: string) => void;
  /** A search monitor's body for its resolved call; empty sends none (#175). */
  resolvedBody: string;
  onResolvedBody: (template: string) => void;
  webhook: string;
  /** For the Slack message the default body becomes. `query` is an HTTP(S) monitor's `GET url`, `series` its last result. */
  preview: { name: string; query: string; series: string; value: string | null; threshold: string };
  /** TOPOSCOPE_PUBLIC_URL is set, so a call links back. */
  canLink: boolean;
  /** The draft to test, or null while it cannot be sent (no search, no webhook, a bad body). */
  testDraft: () => Record<string, unknown> | null;
  /** The editor's footer holds the test call for a default body (18j); a body of its own keeps it under it (18t). */
  testInFooter?: boolean;
  /** A search monitor that opens on fewer than its threshold reads its Slack line the other way round (#176). */
  fewerThan?: boolean;
};

function isSlackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "hooks.slack.com" || host.endsWith(".hooks.slack.com");
  } catch {
    return false;
  }
}

/** Frames 15e–15j: Default | Text | JSON, fill-ins, a JSON fault, Slack's default, a test call. */
export function AlertBodyField({
  alertKind,
  bodyKind,
  onBodyKind,
  template,
  onTemplate,
  resolvedBody,
  onResolvedBody,
  webhook,
  preview,
  canLink,
  testDraft,
  testInFooter = false,
  fewerThan = false,
}: Props) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const resolvedArea = useRef<HTMLTextAreaElement | null>(null);
  /** Which body a fill-in goes into: the last one focused. */
  const target = useRef<"body" | "resolved">("body");
  const fillIns = alertFillIns(alertKind);
  const problem = alertBodyProblem(bodyKind, template, alertKind);
  const jsonFault = bodyKind === "json" ? checkJsonBody(template) : null;
  const slackDefault = bodyKind === "default" && isSlackUrl(webhook.trim());
  const resolves = alertKind !== "first_seen";
  const resolvedProblem = resolves ? resolvedBodyProblem(bodyKind, resolvedBody, alertKind) : null;

  function pick(kind: AlertBodyKind) {
    onBodyKind(kind);
    if (kind !== "default" && !template.trim()) {
      onTemplate(starterAlertBody(kind, alertKind));
    }
  }

  function insert(name: string) {
    const token = `{{${name}}}`;
    const resolved = resolves && target.current === "resolved";
    const el = resolved ? resolvedArea.current : area.current;
    const text = resolved ? resolvedBody : template;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    const next = text.slice(0, at) + token + text.slice(end);
    (resolved ? onResolvedBody : onTemplate)(next);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(at + token.length, at + token.length);
      }
    });
  }

  return (
    <>
      <MonitorField label="Body">
        <span className="flex items-center gap-2.5">
          <MonitorSwitch
            label="Body"
            value={bodyKind}
            options={[
              ["default", "Default"],
              ["text", "Text"],
              ["json", "JSON"],
            ]}
            onChange={pick}
          />
          {bodyKind !== "default" ? (
            <span className="font-mono text-[11.5px] text-muted-foreground">
              content-type: {alertBodyContentType(bodyKind).replace("; charset=utf-8", "")}
            </span>
          ) : null}
        </span>
        {bodyKind === "default" && resolves ? (
          <p className="text-[12.5px] text-muted-foreground">
            Sends <span className="font-mono">state</span> as open, reminder or resolved, with{" "}
            <span className="font-mono">opened_at</span> and <span className="font-mono">resolved_at</span>.
          </p>
        ) : null}
      </MonitorField>
      {bodyKind !== "default" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            {resolves ? <span className="text-[12px] font-semibold">When it opens, and each reminder</span> : null}
            <textarea
              ref={area}
              aria-label="Body"
              aria-invalid={problem ? true : undefined}
              value={template}
              onFocus={() => {
                target.current = "body";
              }}
              onChange={(e) => onTemplate(e.target.value)}
              spellCheck={false}
              className={`h-[150px] resize-none rounded-[6.4px] border bg-background px-2.5 py-2 font-mono text-[12px] leading-[18px] outline-none ${
                problem ? "border-red-400" : "border-white/15"
              }`}
            />
            {problem ? (
              <p role="alert" className="flex gap-1.5 text-[12px] leading-[18px] text-red-300">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                {jsonFault ? (
                  <span>
                    Not JSON yet: line {jsonFault.line}, column {jsonFault.column} — {jsonFault.what}
                    {jsonFault.after ? (
                      <>
                        {" "}after <span className="font-mono">{jsonFault.after}</span>
                      </>
                    ) : null}
                    . Fill-ins count as strings here, so check the quotes around them.
                  </span>
                ) : (
                  <span>{problem[0]!.toUpperCase() + problem.slice(1)}.</span>
                )}
              </p>
            ) : null}
            {resolves ? (
              // 18t / 18u: the resolved call's own body, empty until written.
              <>
                <span className="pt-1.5 text-[12px] font-semibold">When it resolves</span>
                <textarea
                  ref={resolvedArea}
                  aria-label="Resolved body"
                  aria-invalid={resolvedProblem ? true : undefined}
                  value={resolvedBody}
                  onFocus={() => {
                    target.current = "resolved";
                  }}
                  onChange={(e) => onResolvedBody(e.target.value)}
                  spellCheck={false}
                  className={`resize-none rounded-[6.4px] border px-2.5 py-2 font-mono text-[12px] leading-[18px] outline-none ${
                    resolvedProblem
                      ? "h-[150px] border-red-400 bg-background"
                      : resolvedBody.trim()
                        ? "h-[150px] border-white/15 bg-background"
                        : "h-[96px] border-dashed border-white/[0.18] bg-transparent"
                  }`}
                />
                {resolvedProblem ? (
                  <p role="alert" className="flex gap-1.5 text-[12px] leading-[18px] text-red-300">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>{resolvedProblem[0]!.toUpperCase() + resolvedProblem.slice(1)}.</span>
                  </p>
                ) : (
                  <span className="text-[12px] text-muted-foreground">
                    {resolvedBody.trim() ? "Sent once, when it resolves." : "Empty: no resolved call is sent."}
                  </span>
                )}
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-px">
            <span className="pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground">
              FILL IN · click to add
            </span>
            {fillIns.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => insert(f.name)}
                className="flex items-baseline gap-1.5 rounded-[4px] px-1.5 py-0.5 text-left hover:bg-accent"
              >
                <span className="font-mono text-[11.5px] text-violet-300">{`{{${f.name}}}`}</span>
                <span className="text-[11px] text-muted-foreground">{f.about}</span>
                {f.isNew ? (
                  <span className="rounded-[3px] border border-plate/45 px-1 text-[10px] text-plate">new</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {slackDefault ? (
        <div className="flex flex-col gap-2">
          <p className="flex gap-2 rounded-[6.4px] bg-accent px-3 py-2.5 text-[12.5px] leading-[18px]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>
              This is a Slack incoming webhook, so the default body is a Slack message, not
              Toposcope's JSON. Choose Text or JSON to send something else.
            </span>
          </p>
          <span className="text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground">
            THE MESSAGE IT GETS
          </span>
          <div className="flex flex-col gap-1 rounded-[6.4px] border border-white/10 bg-background px-3.5 py-3 text-[13px] leading-[19px]">
            <div>
              <b>{preview.name || "this alert"}</b> {alertKind === "http" ? "open" : "fired"}
            </div>
            <div className="font-mono text-[12px] text-foreground/80">{preview.query || "*"}</div>
            {alertKind === "http" ? (
              <div className="text-foreground/90">{preview.series || "what the run that opened it said"}</div>
            ) : alertKind === "first_seen" ? (
              <div className="text-foreground/90">
                <span className="font-mono text-[12px]">{"{n}"}</span> new fingerprints after{" "}
                <span className="font-mono text-[12px]">{"{mark}"}</span>
              </div>
            ) : (
              <div>
                <b>{preview.series}</b> {preview.value ?? "…"} {fewerThan ? "<" : "≥"} {preview.threshold}
              </div>
            )}
            {canLink ? <span className="text-sky-300">Open in Toposcope</span> : null}
          </div>
        </div>
      ) : null}
      {testInFooter ? null : (
        <TestCall
          alertKind={alertKind}
          disabled={problem !== null || resolvedProblem !== null}
          testDraft={testDraft}
        />
      )}
    </>
  );
}

export function TestCall({
  alertKind,
  disabled,
  testDraft,
  hint = true,
}: {
  alertKind: FillInKind;
  disabled: boolean;
  testDraft: () => Record<string, unknown> | null;
  /** The line beside the button before anything is sent; the footer's button stands alone (18j). */
  hint?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestCallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const draft = testDraft();
  const draftKey = JSON.stringify(draft);

  // A result belongs to the draft it was sent with.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [draftKey]);

  async function send() {
    if (!draft) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/alert-rules/test-call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const json = (await res.json().catch(() => null)) as (TestCallResult & { error?: string }) | null;
      if (!res.ok || !json || json.error) {
        setResult(null);
        setError(json?.error ?? `Test call failed (${res.status})`);
        return;
      }
      setResult(json);
      setShowSent(!json.ok);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Test call failed");
    } finally {
      setBusy(false);
    }
  }

  const clock = (iso: string) => iso.slice(11, 19);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Button
          type="button"
          variant="outline"
          className="h-[30px] shrink-0"
          disabled={busy || disabled || !draft}
          onClick={() => void send()}
        >
          Send a test call
        </Button>
        {result ? (
          <span
            role="status"
            className={`flex items-center gap-1.5 text-[12.5px] ${result.ok ? "text-green-300" : "text-red-300"}`}
          >
            {result.ok ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
            <span>
              <b className="font-mono">
                {result.status ?? "No reply"}
                {result.status_text ? ` ${result.status_text}` : ""}
              </b>{" "}
              in {result.ms} ms · {clock(result.at)}
              {result.ok ? "" : " · it would not have paged"}
            </span>
            {result.resolved ? (
              <span className={result.resolved.ok ? "text-green-300" : "text-red-300"}>
                · then resolved{" "}
                <b className="font-mono">
                  {result.resolved.status ?? "No reply"}
                  {result.resolved.status_text ? ` ${result.resolved.status_text}` : ""}
                </b>{" "}
                in {result.resolved.ms} ms
              </span>
            ) : null}
          </span>
        ) : error ? (
          <span role="status" className="text-[12px] text-red-300">
            {error}
          </span>
        ) : !hint ? null : (
          <span className="text-[11.5px] text-muted-foreground">
            {alertKind === "first_seen"
              ? "Sends this body now, filled in from the last mark it watched."
              : alertKind === "http"
                ? "Sends the open body now, filled in from the last Send; with a resolved body, then that one too."
                : "Sends the open body now; with a resolved body, then that one too."}
          </span>
        )}
      </div>
      {result ? (
        <>
          {result.status !== null ? (
            <div
              className={`flex flex-col gap-1.5 rounded-[6.4px] border bg-background px-3 py-2.5 ${
                result.ok ? "border-white/10" : "border-red-400/35"
              }`}
            >
              <span className="text-[11px] text-muted-foreground">
                The reply, its first 200 characters
              </span>
              <span className="font-mono text-[12px] leading-[18px] break-all">
                {result.reply || "(empty)"}
              </span>
            </div>
          ) : null}
          <button
            type="button"
            aria-expanded={showSent}
            onClick={() => setShowSent((v) => !v)}
            className="self-start rounded-[4.4px] px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent"
          >
            {showSent ? "▾" : "▸"} The body as it was sent
          </button>
          {showSent ? (
            <pre className="m-0 max-h-[180px] overflow-auto rounded-[6.4px] border border-white/[0.08] bg-[#0f0f11] px-3 py-2.5 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-foreground/85">
              {result.sent}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
