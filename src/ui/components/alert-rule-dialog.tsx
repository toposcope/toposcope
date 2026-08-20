import { FormEvent, useEffect, useState } from "react";
import { fireWhenHint, queryPreview, savedWindowLabel } from "@/alert-condition";
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
import type { AlertRule, SavedSearch } from "@/types";
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
    saved_search_id: string;
    threshold: number;
    webhook_url: string;
  }) => Promise<void>;
  onUpdate: (
    id: string,
    input: {
      name: string;
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
  const thresholdOk = Number.isFinite(thresholdN) && thresholdN > 0;

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    setProbe(null);
    if (draft.mode === "edit") {
      setName(draft.rule.name);
      setSavedSearchId(draft.rule.saved_search_id ?? "");
      setThreshold(String(draft.rule.threshold));
      setWebhook(draft.rule.webhook_url ?? "");
      return;
    }
    const item = saved.find((row) => row.id === draft.savedSearchId);
    setName(item?.name ?? "");
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
    if (!trimmed || !savedSearchId || !thresholdOk || probe?.refused) {
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: trimmed,
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
          <DialogDescription>
            Pages when this series is at or above the threshold.
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
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {savedWindowLabel(selected)} · {seriesName}
              </p>
              {probeLoading && !probe ? (
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
          <DialogField label="Fire when" help={fireWhenHint(selected?.agg ?? null)}>
            <DialogControl>
              <span className="shrink-0 font-mono text-[13px]">{seriesName}</span>
              <span className="text-muted-foreground">≥</span>
              <input
                id="alert-threshold"
                type="number"
                min={0}
                step="any"
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
                Boolean(probe?.refused)
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
