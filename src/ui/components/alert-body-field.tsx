import { useEffect, useRef, useState } from "react";
import { CircleAlert, Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogField } from "@/components/ui/dialog";
import type { AlertKind } from "@/types";
import {
  alertBodyContentType,
  alertBodyProblem,
  alertFillIns,
  checkJsonBody,
  starterAlertBody,
  type AlertBodyKind,
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
};

type Props = {
  alertKind: AlertKind;
  bodyKind: AlertBodyKind;
  onBodyKind: (kind: AlertBodyKind) => void;
  template: string;
  onTemplate: (template: string) => void;
  webhook: string;
  /** For the Slack message the default body becomes. */
  preview: { name: string; query: string; series: string; value: string | null; threshold: string };
  /** TOPOSCOPE_PUBLIC_URL is set, so a call links back. */
  canLink: boolean;
  /** The draft to test, or null while it cannot be sent (no search, no webhook, a bad body). */
  testDraft: () => Record<string, unknown> | null;
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
  webhook,
  preview,
  canLink,
  testDraft,
}: Props) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const fillIns = alertFillIns(alertKind);
  const problem = alertBodyProblem(bodyKind, template, alertKind);
  const jsonFault = bodyKind === "json" ? checkJsonBody(template) : null;
  const slackDefault = bodyKind === "default" && isSlackUrl(webhook.trim());

  function pick(kind: AlertBodyKind) {
    onBodyKind(kind);
    if (kind !== "default" && !template.trim()) {
      onTemplate(starterAlertBody(kind, alertKind));
    }
  }

  function insert(name: string) {
    const token = `{{${name}}}`;
    const el = area.current;
    const at = el ? el.selectionStart : template.length;
    const end = el ? el.selectionEnd : template.length;
    const next = template.slice(0, at) + token + template.slice(end);
    onTemplate(next);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(at + token.length, at + token.length);
      }
    });
  }

  return (
    <>
      <div className="h-px bg-white/[0.08]" />
      <DialogField label="Body">
        <span className="flex items-center gap-2.5">
          <span
            role="radiogroup"
            aria-label="Body"
            className="inline-flex h-7 overflow-hidden rounded-[6.4px] border border-white/15"
          >
            {(
              [
                ["default", "Default"],
                ["text", "Text"],
                ["json", "JSON"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={bodyKind === id}
                onClick={() => pick(id)}
                className={
                  bodyKind === id
                    ? "bg-accent px-2.5 text-[12px] text-foreground"
                    : "px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
                }
              >
                {label}
              </button>
            ))}
          </span>
          {bodyKind !== "default" ? (
            <span className="font-mono text-[11.5px] text-muted-foreground">
              content-type: {alertBodyContentType(bodyKind).replace("; charset=utf-8", "")}
            </span>
          ) : null}
        </span>
      </DialogField>
      {bodyKind !== "default" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <textarea
              ref={area}
              aria-label="Body"
              aria-invalid={problem ? true : undefined}
              value={template}
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
              <b>{preview.name || "this alert"}</b> fired
            </div>
            <div className="font-mono text-[12px] text-foreground/80">{preview.query || "*"}</div>
            {alertKind === "first_seen" ? (
              <div className="text-foreground/90">
                <span className="font-mono text-[12px]">{"{n}"}</span> new fingerprints after{" "}
                <span className="font-mono text-[12px]">{"{mark}"}</span>
              </div>
            ) : (
              <div>
                <b>{preview.series}</b> {preview.value ?? "…"} ≥ {preview.threshold}
              </div>
            )}
            {canLink ? <span className="text-sky-300">Open in Toposcope</span> : null}
          </div>
        </div>
      ) : null}
      <TestCall
        alertKind={alertKind}
        disabled={problem !== null}
        testDraft={testDraft}
      />
    </>
  );
}

function TestCall({
  alertKind,
  disabled,
  testDraft,
}: {
  alertKind: AlertKind;
  disabled: boolean;
  testDraft: () => Record<string, unknown> | null;
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
              {result.ok ? "" : " · the alert would not have paged"}
            </span>
          </span>
        ) : error ? (
          <span role="status" className="text-[12px] text-red-300">
            {error}
          </span>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">
            {alertKind === "first_seen"
              ? "Sends this body now, filled in from the last mark it watched."
              : "Sends this body to the webhook now, filled in from the last evaluation."}
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
