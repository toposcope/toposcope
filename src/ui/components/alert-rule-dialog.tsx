import { FormEvent, useEffect, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  firstSeenMarksScope,
  monitorSentence,
  monitorTestDraft,
  queryPreview,
  savedWindowLabel,
} from "@/alert-condition";
import { MarkGlyph } from "@/components/histogram-marks";
import { AlertBodyField, TestCall } from "@/components/alert-body-field";
import { MonitorField, MonitorSwitch, monitorBox } from "@/components/monitor-field";
import { MonitorPlaceFields, serviceMissing, serviceOk, useSeenServices } from "@/components/monitor-place-fields";
import { alertBodyProblem, resolvedBodyProblem, type AlertBodyKind } from "../../shared/alert-body";
import {
  cantTellWords,
  defaultRemind,
  fewerThanProblem,
  remindIds,
  type CantTell,
  type MonitorSource,
  type OpensWhen,
  type RemindId,
} from "../../shared/monitor";
import { parseRangeMs } from "../../query/relative";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatAggStat } from "@/fill-histogram";
import type { AlertKind, AlertRule, SavedSearch } from "@/types";
import { lastLineWords } from "@/watch";
import { seriesLabel } from "../../query/agg";

export type AlertDraft =
  | { mode: "create"; savedSearchId: string; lockSearch: boolean; source: MonitorSource }
  | { mode: "edit"; rule: AlertRule };

/** What the dialog sends to create or update a monitor. */
export type MonitorInput = {
  name: string;
  kind: AlertKind;
  saved_search_id: string;
  threshold: number;
  webhook_url: string;
  body_kind: AlertBodyKind;
  body_template: string;
  resolved_body: string | null;
  remind_every: RemindId;
  opens_when: OpensWhen;
  /** The service it is about (#335): required. */
  service: string;
  /** The host it is about; may be empty. */
  host: string;
};

type Probe = {
  value: number;
  refused: boolean;
  reason?: string;
  agg: string | null;
  /** When the search last matched a line (#176); null when none in a year, absent when unread. */
  lastLineAt?: number | null;
  /** Why a fewer-than reading now could not open it (#176). */
  cantTell: CantTell | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AlertDraft | null;
  saved: SavedSearch[];
  onCreate: (input: MonitorInput) => Promise<void>;
  onUpdate: (id: string, input: MonitorInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** TOPOSCOPE_PUBLIC_URL is set: a call links back. */
  canLink: boolean;
};

/** "15m": the window a monitor's search reads, or "its window" for a fixed from/to. */
function windowWords(item: { range: string | null } | undefined): string {
  return item?.range ?? "its window";
}

/**
 * Frame 18j: a saved-search monitor, at least or fewer than, shut while it can't tell; the
 * resolved body as 18t and 18u draw it. A new-fingerprints monitor uses the same rows.
 */
export function AlertRuleDialog({
  open,
  onOpenChange,
  draft,
  saved,
  onCreate,
  onUpdate,
  onDelete,
  canLink,
}: Props) {
  const editing = draft?.mode === "edit" ? draft.rule : null;
  const lockSearch = draft?.mode === "create" && draft.lockSearch;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AlertKind>("threshold");
  const [bodyKind, setBodyKind] = useState<AlertBodyKind>("default");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [resolvedBody, setResolvedBody] = useState("");
  const [remind, setRemind] = useState<RemindId>(defaultRemind);
  const [opensWhen, setOpensWhen] = useState<OpensWhen>("at_least");
  const [savedSearchId, setSavedSearchId] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [webhook, setWebhook] = useState("");
  const [service, setService] = useState("");
  const [host, setHost] = useState("");
  const seenServices = useSeenServices(open);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = saved.find((item) => item.id === savedSearchId);
  const watchable = saved.filter((item) => !item.board);
  const seriesName = seriesLabel(selected?.agg ?? null);
  const thresholdN = Number(threshold);
  const fingerprints = kind === "first_seen";
  const fewer = !fingerprints && opensWhen === "fewer_than";
  // A first-seen alert counts events: a whole number, at least 1.
  const thresholdOk = fingerprints
    ? Number.isInteger(thresholdN) && thresholdN >= 1
    : Number.isFinite(thresholdN) && thresholdN > 0;
  // A percentile over no lines has no value, and a fixed window never moves on (#176).
  const fewerProblem = fewer && selected ? fewerThanProblem(selected) : null;

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    setProbe(null);
    if (draft.mode === "edit") {
      setName(draft.rule.name);
      setKind(draft.rule.kind ?? "threshold");
      setBodyKind(draft.rule.body_kind ?? "default");
      setBodyTemplate(draft.rule.body_template ?? "");
      setResolvedBody(draft.rule.resolved_body ?? "");
      setRemind(draft.rule.remind_every ?? "window");
      setOpensWhen(draft.rule.opens_when ?? "at_least");
      setSavedSearchId(draft.rule.saved_search_id ?? "");
      setThreshold(String(draft.rule.threshold));
      setWebhook(draft.rule.webhook_url ?? "");
      setService(draft.rule.service ?? "");
      setHost(draft.rule.host ?? "");
      return;
    }
    const item = saved.find((row) => row.id === draft.savedSearchId);
    setName(item?.name ?? "");
    setKind(draft.source === "fingerprints" ? "first_seen" : "threshold");
    setBodyKind("default");
    setBodyTemplate("");
    setResolvedBody("");
    setRemind(defaultRemind);
    setOpensWhen("at_least");
    setSavedSearchId(draft.savedSearchId);
    setThreshold("1");
    setWebhook("");
    setService("");
    setHost("");
  }, [open, draft, saved]);

  useEffect(() => {
    if (!open || !savedSearchId) {
      return;
    }
    const ac = new AbortController();
    setProbe(null);
    setProbeLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/saved-searches/${savedSearchId}/test`, {
          method: "POST",
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(String(res.status));
        }
        const json = (await res.json()) as {
          count: number;
          value?: number;
          refused?: boolean;
          agg?: string | null;
          reason?: string;
          last_line_at?: number | null;
          cant_tell?: CantTell | null;
        };
        if (ac.signal.aborted) {
          return;
        }
        setProbe({
          value: json.value ?? json.count,
          refused: Boolean(json.refused),
          reason: json.reason,
          agg: json.agg ?? null,
          ...("last_line_at" in json ? { lastLineAt: json.last_line_at } : {}),
          cantTell: json.cant_tell ?? null,
        });
      } catch (err) {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setProbe(null);
      } finally {
        if (!ac.signal.aborted) {
          setProbeLoading(false);
        }
      }
    })();
    return () => ac.abort();
  }, [open, savedSearchId]);

  const bodyProblem = alertBodyProblem(bodyKind, bodyTemplate, kind);
  const resolvedProblem = fingerprints ? null : resolvedBodyProblem(bodyKind, resolvedBody, kind);
  const blocked =
    !thresholdOk ||
    bodyProblem !== null ||
    resolvedProblem !== null ||
    fewerProblem !== null ||
    !serviceOk(service) ||
    (!fingerprints && Boolean(probe?.refused));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !savedSearchId || blocked) {
      return;
    }
    setBusy(true);
    try {
      const body: MonitorInput = {
        name: trimmed,
        kind,
        body_kind: bodyKind,
        body_template: bodyTemplate,
        resolved_body: fingerprints || bodyKind === "default" || !resolvedBody.trim() ? null : resolvedBody,
        remind_every: remind,
        opens_when: fingerprints ? "at_least" : opensWhen,
        saved_search_id: savedSearchId,
        threshold: thresholdN,
        webhook_url: webhook.trim(),
        service: service.trim(),
        host: host.trim(),
      };
      if (editing) {
        await onUpdate(editing.id, body);
      } else {
        await onCreate(body);
      }
      onOpenChange(false);
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

  function onPickSearch(id: string) {
    const prev = selected;
    const next = saved.find((item) => item.id === id);
    if (next && prev && name.trim() === prev.name) {
      setName(next.name);
    }
    setSavedSearchId(id);
  }

  function testDraft(): Record<string, unknown> | null {
    return monitorTestDraft({
      id: editing?.id,
      name,
      kind,
      savedSearchId,
      threshold: thresholdN,
      thresholdOk,
      opensWhen,
      webhook,
      bodyKind,
      bodyTemplate,
      resolvedBody,
      problem: bodyProblem !== null || fewerProblem !== null,
    });
  }

  function onPickKind(next: AlertKind) {
    setKind(next);
    if (next === "first_seen" && !(Number.isInteger(thresholdN) && thresholdN >= 1)) {
      setThreshold("1");
    }
  }

  const reads = probe !== null && !probe.refused && thresholdOk;
  const wouldOpen = reads && (fewer ? probe.value < thresholdN : probe.value >= thresholdN);
  const windowMs = (selected?.range ? parseRangeMs(selected.range) : null) ?? 5 * 60_000;
  // Too few lines while it can't tell keeps it shut (#176): say why instead of "would open".
  const cantTell =
    fewer && wouldOpen && probe?.cantTell
      ? cantTellWords({ cant_tell: probe.cantTell, last_status: null }, windowMs, Date.now())
      : null;
  const testHere = bodyKind === "default";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 18j draws a default body at about 630px; 18t widens it for a body of its own and its fill-ins. */}
      <DialogContent
        className={`max-h-[calc(100vh-32px)] overflow-y-auto p-0 ${
          bodyKind === "default" ? "max-w-[min(640px,calc(100vw-32px))]" : "max-w-[min(860px,calc(100vw-32px))]"
        }`}
      >
        {/* 18j: New monitor / its source; 18t: its source / its name. */}
        <div className="flex items-center gap-2 border-b px-[18px] py-3.5">
          <DialogTitle className="flex min-w-0 items-baseline gap-2.5">
            <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
              {editing ? (fingerprints ? "New fingerprints" : "Saved search") : "New monitor"}
            </span>
            <span className="font-normal text-muted-foreground">/</span>
            <span className="truncate">{editing ? editing.name : fingerprints ? "New fingerprints" : "Saved search"}</span>
          </DialogTitle>
          <button
            type="button"
            aria-label="Close"
            className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <form className="flex flex-col" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-3.5 px-[18px] py-4">
            <DialogDescription className={fingerprints ? "text-[12.5px]" : "sr-only"}>
              {fingerprints ? (
                <>
                  Pages when an error fingerprint in{" "}
                  <b className="text-foreground">{selected?.name ?? "this search"}</b> is first seen
                  after a <b className="text-foreground">deploy</b> or{" "}
                  <b className="text-foreground">flag</b> mark, with at least{" "}
                  <b className="text-foreground">{thresholdOk ? threshold : "N"}</b>{" "}
                  {thresholdN === 1 ? "event" : "events"} after it. Each mark is watched for 24 hours,
                  and each fingerprint is sent once, for the last mark before it first appeared.
                </>
              ) : selected ? (
                monitorSentence(selected, thresholdOk ? threshold : "N", remind, opensWhen)
              ) : (
                "Opens when this series is at least, or fewer than, the threshold, and says when it resolved."
              )}
            </DialogDescription>
            {editing ? (
              <MonitorField label="Source">
                <MonitorSwitch
                  label="Source"
                  value={kind}
                  options={[
                    ["threshold", "Saved search"],
                    ["first_seen", "New fingerprints"],
                  ]}
                  onChange={onPickKind}
                />
              </MonitorField>
            ) : null}
            <MonitorField label="Search" htmlFor="alert-search">
              {lockSearch ? (
                <span className={monitorBox}>
                  {selected?.name ?? "—"} · {seriesName}
                </span>
              ) : (
                <span className={`${monitorBox} relative pr-7`}>
                  <select
                    id="alert-search"
                    className="min-w-0 flex-1 appearance-none bg-transparent text-[13px] outline-none"
                    value={savedSearchId}
                    onChange={(e) => onPickSearch(e.target.value)}
                    disabled={saved.length === 0}
                  >
                    {watchable.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {seriesLabel(item.agg ?? null)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 size-3 text-muted-foreground" />
                </span>
              )}
              {selected ? (
                <span
                  className="truncate font-mono text-[12px] text-muted-foreground"
                  title={queryPreview(selected.query)}
                >
                  {queryPreview(selected.query)}
                  {fingerprints ? "" : ` · ${savedWindowLabel(selected).toLowerCase()} · ${seriesName}`}
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground">Save a search first.</span>
              )}
            </MonitorField>
            {fingerprints ? (
              <MonitorField label="Marks">
                <span className="flex flex-wrap items-center gap-2 text-[12px]">
                  {(["deploy", "flag"] as const).map((k) => (
                    <span key={k} className="inline-flex h-6 items-center gap-1.5 rounded-[4px] bg-accent px-2">
                      <MarkGlyph kind={k} size={10} />
                      {k}
                    </span>
                  ))}
                  <span className="text-[11.5px] text-muted-foreground">
                    {firstSeenMarksScope(selected?.query ?? "")} · watched for 24h each
                  </span>
                </span>
              </MonitorField>
            ) : null}
            <MonitorField label={fingerprints ? "Fire when" : "Opens when"} htmlFor="alert-threshold">
              <span className="flex flex-wrap items-center gap-2.5">
                {fingerprints ? (
                  <span className="text-[13px] text-muted-foreground">at least</span>
                ) : (
                  <>
                    <span className="font-mono text-[13px]">{seriesName === "Count" ? "count" : seriesName}</span>
                    <MonitorSwitch
                      label="Opens when"
                      value={opensWhen}
                      options={[
                        ["at_least", "at least"],
                        ["fewer_than", "fewer than"],
                      ]}
                      onChange={setOpensWhen}
                    />
                  </>
                )}
                <input
                  id="alert-threshold"
                  type="number"
                  min={fingerprints ? 1 : 0}
                  step={fingerprints ? 1 : "any"}
                  value={threshold}
                  autoFocus={Boolean(draft && draft.mode === "create")}
                  onChange={(e) => setThreshold(e.target.value)}
                  className={`${monitorBox} w-[70px] bg-transparent font-mono outline-none`}
                />
                <span className="text-[13px] text-muted-foreground">
                  {fingerprints ? "events of a new fingerprint after the mark" : `in ${windowWords(selected)}`}
                </span>
              </span>
              {fingerprints || !selected ? null : (
                <span className="flex flex-col gap-1 rounded-[6px] border border-white/[0.08] bg-[#0f0f11] px-2.5 py-2">
                  {fewerProblem ? (
                    <span className="text-[12.5px] text-destructive">{fewerProblem[0]!.toUpperCase() + fewerProblem.slice(1)}.</span>
                  ) : probeLoading && !probe ? (
                    <span className="text-[12.5px] text-muted-foreground">Checking…</span>
                  ) : probe?.refused ? (
                    <span className="text-[12.5px] text-destructive">{probe.reason ?? "This series cannot be evaluated."}</span>
                  ) : probe ? (
                    <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
                      <span className="shrink-0 font-mono">now {formatAggStat(probe.value)}</span>
                      {fewer ? (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="min-w-0 truncate font-mono">
                            last line {lastLineWords(probe.lastLineAt, Date.now())}
                          </span>
                        </>
                      ) : null}
                      <span className="ml-auto shrink-0">
                        {cantTell ? (
                          <span className="text-[12px] text-muted-foreground">can't tell: {cantTell}</span>
                        ) : wouldOpen ? (
                          <Badge variant="error">would open</Badge>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">
                            {fewer ? "at or above threshold" : "below threshold"}
                          </span>
                        )}
                      </span>
                    </span>
                  ) : null}
                  {fewer && !fewerProblem ? (
                    <span className="text-[12.5px] leading-[1.45] text-muted-foreground">
                      Stays shut while it can't tell: the first {windowWords(selected)} after Toposcope starts, a
                      refused reading, or a linked source that is behind.
                    </span>
                  ) : null}
                </span>
              )}
            </MonitorField>
            {fingerprints ? null : (
              <MonitorField label="Remind">
                <MonitorSwitch
                  label="Remind"
                  value={remind}
                  options={remindIds.map((id) => [id, id === "window" ? `every ${selected?.range ?? "5m"}` : id] as const)}
                  onChange={setRemind}
                />
              </MonitorField>
            )}
            <MonitorField label="Name" htmlFor="alert-name">
              <input
                id="alert-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${monitorBox} bg-transparent outline-none`}
              />
            </MonitorField>
            <MonitorPlaceFields
              kind="search"
              service={service}
              onService={setService}
              host={host}
              onHost={setHost}
              seen={seenServices}
              layout="field"
            />
            <MonitorField label="Webhook" htmlFor="alert-webhook">
              <input
                id="alert-webhook"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder="https://hooks.slack.com/services/… or https://example.com/hook"
                className={`${monitorBox} bg-transparent font-mono outline-none placeholder:text-muted-foreground`}
              />
            </MonitorField>
            <AlertBodyField
              alertKind={kind}
              bodyKind={bodyKind}
              onBodyKind={setBodyKind}
              template={bodyTemplate}
              onTemplate={setBodyTemplate}
              resolvedBody={resolvedBody}
              onResolvedBody={setResolvedBody}
              webhook={webhook}
              preview={{
                name: name.trim(),
                query: selected?.query ?? "",
                series: seriesName,
                value: probe && !probe.refused ? formatAggStat(probe.value) : null,
                threshold,
              }}
              canLink={canLink}
              testDraft={testDraft}
              testInFooter={testHere}
              fewerThan={fewer}
            />
            {editing &&
            (editing.consecutive_failures > 0 ||
              editing.last_status === "refused" ||
              editing.last_status === "error") ? (
              <p className="text-[12px] text-destructive" title={editing.last_error ?? undefined}>
                Last attempt {editing.last_status ?? "error"}
                {editing.consecutive_failures > 1 ? ` ×${editing.consecutive_failures}` : ""}
                {editing.last_attempt_at
                  ? ` · ${new Date(editing.last_attempt_at).toISOString().slice(0, 16).replace("T", " ")}Z`
                  : ""}
              </p>
            ) : null}
          </div>
          {/* 18j: the test call on the left, Cancel and Create on the right. */}
          <div className="flex items-start gap-2 border-t px-[18px] py-3">
            <span className="min-w-0 flex-1">
              {testHere ? (
                <TestCall
                  alertKind={kind}
                  disabled={bodyProblem !== null || resolvedProblem !== null}
                  testDraft={testDraft}
                  hint={false}
                />
              ) : null}
            </span>
            {serviceOk(service) ? null : (
              <span className="self-center text-[12px] text-muted-foreground">{serviceMissing}</span>
            )}
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="h-[30px] text-destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete
              </Button>
            ) : null}
            <DialogClose type="button" className="h-[30px] border border-white/15 text-foreground">
              Cancel
            </DialogClose>
            <span title={serviceOk(service) ? undefined : serviceMissing}>
              <Button type="submit" className="h-[30px]" disabled={busy || saved.length === 0 || blocked}>
                {editing ? "Save" : "Create"}
              </Button>
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
