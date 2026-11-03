import { FormEvent, useEffect, useState } from "react";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "update";
  defaultName: string;
  query: string;
  rangeLabel: string;
  onSave: (name: string) => Promise<void>;
  onSaveAs?: (name: string) => Promise<void>;
};

export function SaveSearchDialog({
  open,
  onOpenChange,
  mode,
  defaultName,
  query,
  rangeLabel,
  onSave,
  onSaveAs,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
    }
  }, [open, defaultName]);

  const canSubmit = name.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !canSubmit) {
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function saveAs() {
    const trimmed = name.trim();
    if (!trimmed || !canSubmit || !onSaveAs) {
      return;
    }
    setSaving(true);
    try {
      await onSaveAs(trimmed);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "update" ? "Update saved hunt" : "Save hunt"}</DialogTitle>
          <DialogDescription>
            Names this query and window. Monitors watch saved hunts.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <DialogField label="Name">
            <DialogControl>
              <input
                id="save-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Checkout 5xx"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          <DialogField label="Query">
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {query || "all logs"}
              </span>
            </DialogControl>
          </DialogField>
          <DialogField label="Range" help="Live keeps the window ending now.">
            <DialogControl>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {rangeLabel}
              </span>
            </DialogControl>
          </DialogField>
          <DialogFooter>
            <DialogClose type="button">Cancel</DialogClose>
            {mode === "update" && onSaveAs ? (
              <Button size="lg" type="button" variant="outline" disabled={saving || !canSubmit} onClick={() => void saveAs()}>
                Save as…
              </Button>
            ) : null}
            <Button size="lg" type="submit" busy={saving} disabled={!canSubmit}>
              {mode === "update" ? "Update" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
