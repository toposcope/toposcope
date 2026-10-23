import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
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
import { formatCompactCount, formatFieldCount, setCountFormat, useCountFormat } from "@/count-format";
import { formatEventClock, setTimestampFormat, useTimestampFormat } from "@/event-time";
import { shareIsLive } from "@/share-cover";
import { useShares } from "@/use-shares";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetentionDays?: (days: number) => void;
  /** The name changed: the header and the tab title follow. */
  onInstanceName?: (name: string | null) => void;
  /** Settings → Shares (#228). */
  onOpenShares?: () => void;
};

const previewN = 1240;

export function SettingsDialog({ open, onOpenChange, onRetentionDays, onInstanceName, onOpenShares }: Props) {
  const shares = useShares();
  const liveShares = shares.filter((share) => shareIsLive(share)).length;
  const [days, setDays] = useState("30");
  // Empty: metrics follow Retention days.
  const [metricsDays, setMetricsDays] = useState("");
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const [webhook, setWebhook] = useState("");
  const [saving, setSaving] = useState(false);
  const countFormat = useCountFormat();
  const timestampFormat = useTimestampFormat();
  const endpoint =
    typeof window === "undefined" ? "/v1/logs" : `${window.location.origin}/v1/logs`;

  useEffect(() => {
    if (!open) {
      return;
    }
    void fetch("/api/settings").then(async (res) => {
      if (!res.ok) {
        toast.error("Failed to load settings");
        return;
      }
      const json = (await res.json()) as {
        retention_days: number;
        metrics_retention_days?: number | null;
        instance_name?: string | null;
        default_webhook_url?: string | null;
      };
      setDays(String(json.retention_days));
      setMetricsDays(json.metrics_retention_days == null ? "" : String(json.metrics_retention_days));
      setName(json.instance_name ?? "");
      setSavedName(json.instance_name ?? null);
      setWebhook(json.default_webhook_url ?? "");
    });
  }, [open]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const retentionDays = Number(days);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      toast.error("Retention must be 1–365 days");
      return;
    }
    const metricsRetentionDays = metricsDays.trim() === "" ? null : Number(metricsDays);
    if (
      metricsRetentionDays !== null &&
      (!Number.isInteger(metricsRetentionDays) || metricsRetentionDays < 1 || metricsRetentionDays > 730)
    ) {
      toast.error("Metrics retention must be 1–730 days");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retention_days: retentionDays,
          metrics_retention_days: metricsRetentionDays,
          instance_name: name,
          default_webhook_url: webhook.trim(),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(err?.error ?? `Save failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as {
        retention_days: number;
        metrics_retention_days?: number | null;
        instance_name?: string | null;
      };
      setDays(String(json.retention_days));
      setMetricsDays(json.metrics_retention_days == null ? "" : String(json.metrics_retention_days));
      onRetentionDays?.(json.retention_days);
      if ((json.instance_name ?? null) !== savedName) {
        onInstanceName?.(json.instance_name ?? null);
      }
      toast.success(
        json.metrics_retention_days == null
          ? `Retention set to ${json.retention_days} days`
          : `Retention set: logs ${json.retention_days} days, metrics ${json.metrics_retention_days}`,
      );
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function copyEndpoint() {
    await navigator.clipboard.writeText(endpoint);
    toast.success("Endpoint copied");
  }

  const countLabel =
    countFormat === "raw"
      ? `Raw — ${formatFieldCount(previewN, "raw")}`
      : `Compact — ${formatCompactCount(previewN)}`;
  const previewIso = "2026-08-14T04:30:00.000Z";
  const previewNow = Date.parse("2026-08-14T12:00:00.000Z");
  const timestampLabel =
    timestampFormat === "full"
      ? `Full — ${formatEventClock(previewIso, {
          format: "full",
          fromMs: previewNow,
          spanMs: 3_600_000,
          nowMs: previewNow,
        })}`
      : `Compact — ${formatEventClock(previewIso, {
          format: "compact",
          fromMs: Date.parse("2026-08-14T11:00:00.000Z"),
          spanMs: 3_600_000,
          nowMs: previewNow,
        })}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            ClickHouse TTL for each signal and its rollups.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void onSave(e)}>
          <DialogField label="Instance name">
            <DialogControl>
              <input
                id="instance-name"
                value={name}
                maxLength={64}
                placeholder="unnamed"
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {savedName && name.trim() !== savedName ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">was {savedName}</span>
              ) : null}
            </DialogControl>
          </DialogField>
          <DialogField
            label="Retention days"
            help="Logs, spans, profiles and marks. Applies ALTER TTL on save."
          >
            <DialogControl>
              <input
                id="retention"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
              />
              <span className="shrink-0 text-[11px] text-muted-foreground">1–365</span>
            </DialogControl>
          </DialogField>
          <DialogField
            label="Metrics retention days"
            help="Ingested metrics and their minute rollups. Empty follows Retention days."
          >
            <DialogControl>
              <input
                id="metrics-retention"
                type="number"
                min={1}
                max={730}
                value={metricsDays}
                placeholder={`${days.trim() || "30"} · as logs`}
                onChange={(e) => setMetricsDays(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
              />
              <span className="shrink-0 text-[11px] text-muted-foreground">1–730</span>
            </DialogControl>
          </DialogField>
          <DialogField
            label="Default webhook"
            help="Called by any monitor without its own, such as one created by its first result. Empty: such a monitor keeps its state and calls nobody."
          >
            <DialogControl>
              <input
                id="default-webhook"
                type="url"
                value={webhook}
                placeholder="https://…"
                onChange={(e) => setWebhook(e.target.value)}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          <DialogField
            label="Count format"
            help="Applies to facets, the table footer and alert counts."
          >
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {countLabel}
              </span>
              <button
                type="button"
                className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
                onClick={() =>
                  setCountFormat(countFormat === "human" ? "raw" : "human")
                }
              >
                Switch
              </button>
            </DialogControl>
          </DialogField>
          <DialogField
            label="Timestamps"
            help="Compact follows the histogram date rule. Full is always date and milliseconds. This browser, not saved searches."
          >
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {timestampLabel}
              </span>
              <button
                type="button"
                className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
                onClick={() =>
                  setTimestampFormat(timestampFormat === "compact" ? "full" : "compact")
                }
              >
                Switch
              </button>
            </DialogControl>
          </DialogField>
          <DialogField label="Ingest endpoint">
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {endpoint}
              </span>
              <button
                type="button"
                className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
                onClick={() => void copyEndpoint()}
              >
                Copy
              </button>
            </DialogControl>
          </DialogField>
          {onOpenShares ? (
            <DialogField label="Shares" help="Another app reads one scope of numbers, never events.">
              <DialogControl>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                  {liveShares === 0 ? "none" : `${liveShares} live`}
                </span>
                <button
                  type="button"
                  className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
                  onClick={onOpenShares}
                >
                  Open
                </button>
              </DialogControl>
            </DialogField>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={saving} className="h-8">
              Save
            </Button>
            <span className="flex-1" />
            <DialogClose type="button">Cancel</DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
