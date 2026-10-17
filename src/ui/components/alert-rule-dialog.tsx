import { FormEvent, useEffect, useState } from "react";
import {
  firstSeenMarksScope,
  fireWhenHint,
  queryPreview,
  savedWindowLabel,
  thresholdSentence,
} from "@/alert-condition";
import { MarkGlyph } from "@/components/histogram-marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogControl,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatAggStat } from "@/fill-histogram";
import type { AlertKind, AlertRule, SavedSearch } from "@/types";
import { seriesLabel } from "../../query/agg";

export type AlertDraft =
  | { mode: "create"; savedSearchId: string; lockSearch: boolean }
  | { mode: "edit"; rule: AlertRule };

type Probe = {
  value: number;
  refused: boolean;
  reason?: string;
  agg: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AlertDraft | null;
  saved: SavedSearch[];
  onCreate: (input: {
    name: string;
    kind: AlertKind;
    saved_search_id: string;
    threshold: number;
    webhook_url: string;
  }) => Promise<void>;
  onUpdate: (
    id: string,
    input: {
      name: string;
      kind: AlertKind;
      saved_search_id: string;
      threshold: number;
      webhook_url: string;
    },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function AlertRuleDialog({
  open,
  onOpenChange,
  draft,
  saved,
  onCreate,
  onUpdate,
  onDelete,
}: Props) {
  const editing = draft?.mode === "edit" ? draft.rule : null;
  const lockSearch = draft?.mode === "create" && draft.lockSearch;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AlertKind>("threshold");
  const [savedSearchId, setSavedSearchId] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [webhook, setWebhook] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = saved.find((item) => item.id === savedSearchId);
  const watchable = saved.filter((item) => !item.board);
  const seriesName = seriesLabel(selected?.agg ?? null);
  const thresholdN = Number(threshold);
  const fingerprints = kind === "first_seen";
  // A first-seen alert counts events: a whole number, at least 1.
  const thresholdOk = fingerprints
    ? Number.isInteger(thresholdN) && thresholdN >= 1
    : Number.isFinite(thresholdN) && thresholdN > 0;

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    setProbe(null);
    if (draft.mode === "edit") {
      setName(draft.rule.name);
      setKind(draft.rule.kind ?? "threshold");
      setSavedSearchId(draft.rule.saved_search_id ?? "");
      setThreshold(String(draft.rule.threshold));
      setWebhook(draft.rule.webhook_url ?? "");
      return;
    }
    const item = saved.find((row) => row.id === draft.savedSearchId);
    setName(item?.name ?? "");
    setKind("threshold");
    setSavedSearchId(draft.savedSearchId);
    setThreshold("1");
    setWebhook("");
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
        };
        if (ac.signal.aborted) {
          return;
        }
        setProbe({
          value: json.value ?? json.count,
          refused: Boolean(json.refused),
          reason: json.reason,
          agg: json.agg ?? null,
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !savedSearchId || !thresholdOk || (!fingerprints && probe?.refused)) {
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: trimmed,
        kind,
        saved_search_id: savedSearchId,
        threshold: thresholdN,
        webhook_url: webhook.trim(),
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

  const title = editing
    ? "Edit alert"
    : lockSearch
      ? "Alert on this search"
      : "New alert";

  function onPickKind(next: AlertKind) {
    setKind(next);
    if (next === "first_seen" && !(Number.isInteger(thresholdN) && thresholdN >= 1)) {
      setThreshold("1");
    }
  }

  const wouldFire =
    probe !== null &&
    !probe.refused &&
    thresholdOk &&
    probe.value >= thresholdN;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <div
            role="radiogroup"
            aria-label="Kind"
            className="mt-1 inline-flex h-[30px] self-start overflow-hidden rounded-[6.4px] border border-white/15"
          >
            {(
              [
                ["threshold", "Threshold"],
                ["first_seen", "New fingerprints"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={kind === id}
                onClick={() => onPickKind(id)}
                className={
                  kind === id
                    ? "bg-accent px-3 text-[12.5px] text-foreground"
                    : "px-3 text-[12.5px] text-muted-foreground hover:text-foreground"
                }
              >
                {label}
              </button>
            ))}
          </div>
          <DialogDescription>
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
              thresholdSentence(selected, thresholdOk ? threshold : "N")
            ) : (
              "Pages when this series is at or above the threshold."
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          {lockSearch ? null : (
            <DialogField label="Search">
              <DialogControl>
                <select
                  id="alert-search"
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
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
              </DialogControl>
            </DialogField>
          )}
          {selected ? (
            <div className="rounded-[4.4px] border border-white/10 bg-accent/30 px-2.5 py-2">
              {lockSearch ? (
                <p className="text-[13px]">{selected.name}</p>
              ) : null}
              <p
                className="truncate font-mono text-[11.5px]"
                title={queryPreview(selected.query)}
              >
                {queryPreview(selected.query)}
              </p>
              {fingerprints ? null : (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {savedWindowLabel(selected)} · {seriesName}
                </p>
              )}
              {fingerprints ? null : probeLoading && !probe ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">Checking…</p>
              ) : probe?.refused ? (
                <p className="mt-1.5 text-[11px] text-destructive">
                  {probe.reason ?? "This series cannot be evaluated."}
                </p>
              ) : probe ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>
                    Now {formatAggStat(probe.value)}
                    {thresholdOk ? ` · threshold ${threshold}` : ""}
                  </span>
                  {wouldFire ? (
                    <Badge variant="error">would fire</Badge>
                  ) : (
                    <span>below threshold</span>
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">Save a search first.</p>
          )}
          {fingerprints ? (
            <DialogField label="Marks">
              <span className="flex flex-wrap items-center gap-2 text-[12px]">
                {(["deploy", "flag"] as const).map((k) => (
                  <span
                    key={k}
                    className="inline-flex h-6 items-center gap-1.5 rounded-[4px] bg-accent px-2"
                  >
                    <MarkGlyph kind={k} size={10} />
                    {k}
                  </span>
                ))}
                <span className="text-[11.5px] text-muted-foreground">
                  {firstSeenMarksScope(selected?.query ?? "")} · watched for 24h each
                </span>
              </span>
            </DialogField>
          ) : null}
          <DialogField
            label="Fire when"
            help={
              fingerprints
                ? "events of a new fingerprint after the mark"
                : fireWhenHint(selected?.agg ?? null)
            }
          >
            <DialogControl>
              {fingerprints ? null : (
                <span className="shrink-0 font-mono text-[13px]">{seriesName}</span>
              )}
              <span className="text-muted-foreground">≥</span>
              <input
                id="alert-threshold"
                type="number"
                min={fingerprints ? 1 : 0}
                step={fingerprints ? 1 : "any"}
                value={threshold}
                autoFocus={Boolean(draft && draft.mode === "create")}
                onChange={(e) => setThreshold(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
              />
            </DialogControl>
          </DialogField>
          <DialogField label="Name">
            <DialogControl>
              <input
                id="alert-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </DialogControl>
          </DialogField>
          <DialogField label="Webhook">
            <DialogControl>
              <input
                id="alert-webhook"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder="https://hooks.slack.com/services/… or https://example.com/hook"
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          {editing &&
          (editing.consecutive_failures > 0 ||
            editing.last_status === "refused" ||
            editing.last_status === "error") ? (
            <p className="text-[12px] text-destructive" title={editing.last_error ?? undefined}>
              Last attempt {editing.last_status ?? "error"}
              {editing.consecutive_failures > 1
                ? ` ×${editing.consecutive_failures}`
                : ""}
              {editing.last_attempt_at
                ? ` · ${new Date(editing.last_attempt_at).toISOString().slice(0, 16).replace("T", " ")}Z`
                : ""}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              className="h-8"
              disabled={
                busy ||
                saved.length === 0 ||
                !thresholdOk ||
                (!fingerprints && Boolean(probe?.refused))
              }
            >
              {editing ? "Save" : "Create"}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="h-8 text-destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete
              </Button>
            ) : null}
            <span className="flex-1" />
            <DialogClose type="button">Cancel</DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
