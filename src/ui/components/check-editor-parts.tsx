import type { ReactNode, RefObject } from "react";
import { AlertBodyField } from "@/components/alert-body-field";
import { cn } from "@/lib/utils";
import { editorLines, removeLine, setLineLevel, webhookShort } from "@/http-editor";
import type { AlertBodyKind, FillInKind } from "../../shared/alert-body";
import { httpEveryIds, type CheckKind, type LineResult } from "../../shared/http-check";
import type { RemindId } from "../../shared/monitor";

/**
 * Frame 18r's parts that a check run from this node shares, HTTP(S) (#178) or TCP · certificate
 * (#180): the picked-value chip, the Conditions panel with its stored lines, and the name, run
 * and calls rows under it.
 */

export const box = "box-border flex min-h-[30px] items-center gap-2 rounded-[6px] border border-white/15 px-2.5 py-[5px] text-[13px]";
export const btn2 = "h-[30px] rounded-[6px] border border-white/15 bg-transparent px-3 text-[13px] text-foreground hover:bg-accent disabled:opacity-50";
export const btn = "h-[30px] rounded-[6px] bg-[#e4e4e7] px-3.5 text-[13px] font-medium text-[#18181b] hover:bg-white disabled:opacity-50";
const add =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border border-dashed border-[rgba(231,225,211,.6)] bg-transparent px-[7px] text-[11px] whitespace-nowrap text-[#e7e1d3] hover:bg-[rgba(231,225,211,.08)]";
const remindIds = ["off", "1h", "4h", "24h"] as const;
const failAfterIds = [1, 2, 3, 5] as const;

export function AddChip({ line, label, onAdd }: { line: string; label?: string; onAdd: (line: string) => void }) {
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

export function Seg<T extends string | number>({
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

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function mmdd(iso: string): string {
  return iso.slice(5, 10);
}

/** Each line as a row with its result and a fail | warn toggle, then the lines as stored. */
export function ConditionsPanel({
  kind,
  lines,
  setLines,
  results,
  none,
}: {
  kind: CheckKind;
  lines: string;
  setLines: (next: (text: string) => string) => void;
  /** Each good line's result on the last run, by its line index. */
  results: Map<number, LineResult>;
  /** What passes with no lines: "any 2xx passes". */
  none: string;
}) {
  const rows = editorLines(lines, kind);
  const good = rows.filter((r) => r.line).length;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold">Conditions</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {good > 0 ? `${good} · all must pass` : `none · ${none}`}
        </span>
      </div>
      {rows.map((row) => {
        const r = results.get(row.index);
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
                    onClick={() => setLines((t) => setLineLevel(t, row.index, lv, kind))}
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
          onChange={(e) => {
            const next = e.target.value;
            setLines(() => next);
          }}
          className="resize-y rounded-[5px] border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-[#d4d4d8] outline-none"
        />
      </label>
    </>
  );
}

/** The good lines' results on the last run, by line index, as `ConditionsPanel` reads them. */
export function resultsByLine(lines: string, kind: CheckKind, verdictLines: readonly LineResult[] | null): Map<number, LineResult> {
  const out = new Map<number, LineResult>();
  if (!verdictLines) {
    return out;
  }
  let k = 0;
  for (const r of editorLines(lines, kind)) {
    if (r.line) {
      out.set(r.index, verdictLines[k++]!);
    }
  }
  return out;
}

export type RunCallsState = {
  name: string;
  every: string;
  failAfter: number;
  webhook: string;
  remind: RemindId;
  bodyKind: AlertBodyKind;
  bodyTemplate: string;
  resolvedBody: string;
};

/** A setter for each of them. */
export type RunCallsSet = { [K in keyof RunCallsState]: (value: RunCallsState[K]) => void };

/** The name, run and calls rows under the lines (18r), each run and calls panel opened by Change. */
export function RunCallsRows({
  state,
  set,
  namePlaceholder,
  open,
  onToggle,
  webhookRef,
  fallback,
  alertKind,
  preview,
  canLink,
  testDraft,
  children,
}: {
  state: RunCallsState;
  set: RunCallsSet;
  namePlaceholder: string;
  open: { run: boolean; calls: boolean };
  onToggle: (which: "run" | "calls") => void;
  webhookRef: RefObject<HTMLInputElement | null>;
  /** The default webhook in Settings, which it calls without one of its own (18r: `default · …`). */
  fallback: string | null;
  alertKind: FillInKind;
  preview: { name: string; query: string; series: string };
  canLink: boolean;
  testDraft: () => Record<string, unknown> | null;
  /** Rows of its own after calls: an HTTP(S) monitor's request. */
  children?: ReactNode;
}) {
  const { name, every, failAfter, webhook, remind, bodyKind, bodyTemplate, resolvedBody } = state;
  return (
    <div className="mt-auto flex flex-col gap-1.5 border-t border-white/[0.08] pt-2.5">
      <span className="flex items-center gap-2 text-[12px]">
        <span className="w-14 shrink-0 text-muted-foreground">name</span>
        <input
          aria-label="Name"
          value={name}
          placeholder={namePlaceholder}
          onChange={(e) => set.name(e.target.value)}
          className={cn(box, "min-h-7 flex-1 bg-transparent outline-none placeholder:text-muted-foreground")}
        />
      </span>
      <span className="flex items-center gap-2 text-[12px]">
        <span className="w-14 shrink-0 text-muted-foreground">run</span>
        <span className="min-w-0 truncate font-mono">
          every {every} · open after {failAfter} failed run{failAfter === 1 ? "" : "s"}
        </span>
        <button type="button" aria-expanded={open.run} className="ml-auto shrink-0 hover:underline" onClick={() => onToggle("run")}>
          {open.run ? "Done" : "Change"}
        </button>
      </span>
      {open.run ? (
        <span className="flex flex-wrap items-center gap-2 rounded-[6px] border border-white/10 bg-[#0f0f11] p-2.5 text-[12px] text-muted-foreground">
          every
          <Seg label="Every" ids={httpEveryIds} value={every as (typeof httpEveryIds)[number]} onPick={(v) => set.every(v)} />
          open after
          <Seg
            label="Open after"
            ids={failAfterIds}
            value={failAfter as (typeof failAfterIds)[number]}
            onPick={(v) => set.failAfter(v)}
          />
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
          · {remind === "off" ? "no reminders" : `remind ${remind}`}
          {bodyKind !== "default" ? ` · ${bodyKind} body` : ""}
        </span>
        <button type="button" aria-expanded={open.calls} className="ml-auto shrink-0 hover:underline" onClick={() => onToggle("calls")}>
          {open.calls ? "Done" : "Change"}
        </button>
      </span>
      {open.calls ? (
        <div className="flex flex-col gap-3 rounded-[6px] border border-white/10 bg-[#0f0f11] p-2.5">
          <span className="flex items-center gap-2 text-[12px]">
            <span className="w-[58px] shrink-0 text-muted-foreground">webhook</span>
            <input
              ref={webhookRef}
              aria-label="Webhook"
              value={webhook}
              onChange={(e) => set.webhook(e.target.value)}
              placeholder={fallback ? `empty: the default, ${webhookShort(fallback)}` : "https://ntfy.sh/… or https://hooks.slack.com/services/…"}
              className={cn(box, "min-h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground")}
            />
          </span>
          <span className="pl-[66px] text-[11px] text-muted-foreground">
            Left empty, it calls the default webhook, set in Settings for any monitor without its own.
          </span>
          <span className="flex items-center gap-2 text-[12px]">
            <span className="w-[58px] shrink-0 text-muted-foreground">remind</span>
            <Seg label="Remind" ids={remindIds} value={remind as (typeof remindIds)[number]} onPick={(v) => set.remind(v)} />
          </span>
          <AlertBodyField
            alertKind={alertKind}
            bodyKind={bodyKind}
            onBodyKind={(v) => set.bodyKind(v)}
            template={bodyTemplate}
            onTemplate={(v) => set.bodyTemplate(v)}
            resolvedBody={resolvedBody}
            onResolvedBody={(v) => set.resolvedBody(v)}
            webhook={webhook.trim() || fallback || ""}
            preview={{ ...preview, value: null, threshold: "" }}
            canLink={canLink}
            testDraft={testDraft}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
}
