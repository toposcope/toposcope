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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetentionDays?: (days: number) => void;
};

const previewN = 1240;

export function SettingsDialog({ open, onOpenChange, onRetentionDays }: Props) {
  const [days, setDays] = useState("30");
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
      const json = (await res.json()) as { retention_days: number };
      setDays(String(json.retention_days));
    });
  }, [open]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const retentionDays = Number(days);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      toast.error("Retention must be 1–365 days");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retention_days: retentionDays }),
      });
      if (!res.ok) {
        toast.error(`Save failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as { retention_days: number };
      setDays(String(json.retention_days));
      onRetentionDays?.(json.retention_days);
      toast.success(`Retention set to ${json.retention_days} days`);
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
            ClickHouse TTL for logs and the minute histogram.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void onSave(e)}>
          <DialogField label="Retention days" help="Applies ALTER TTL on save.">
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
