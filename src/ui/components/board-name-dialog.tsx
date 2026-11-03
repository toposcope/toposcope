import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogControl,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** New board… (39e) and a board's Save as…: a name, then the board is made. */
export function BoardNameDialog({
  open,
  onOpenChange,
  title,
  action,
  defaultName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  action: string;
  defaultName: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
    }
  }, [open, defaultName]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setSaving(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <DialogField label="Name">
            <DialogControl>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Checkout incident"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          <DialogFooter>
            <DialogClose type="button">Cancel</DialogClose>
            <Button size="lg" type="submit" busy={saving} disabled={!name.trim()}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
