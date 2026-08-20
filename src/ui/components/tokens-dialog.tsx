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

type Token = {
  id: string;
  name: string;
  created_at: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function TokensDialog({ open, onOpenChange }: Props) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/api-tokens");
    if (!res.ok) {
      toast.error("Failed to load tokens");
      return;
    }
    const json = (await res.json()) as { tokens: Token[] };
    setTokens(json.tokens);
  }

  useEffect(() => {
    if (open) {
      setSecret(null);
      void load();
    }
  }, [open]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const res = await fetch("/api/api-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) {
      toast.error(`Create failed (${res.status})`);
      return;
    }
    const json = (await res.json()) as Token & { token: string };
    setSecret(json.token);
    setName("");
    await load();
  }

  async function onCopy() {
    if (!secret) {
      return;
    }
    await navigator.clipboard.writeText(secret);
    toast.success("Token copied");
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/api-tokens/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(`Delete failed (${res.status})`);
      return;
    }
    await load();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ingest tokens</DialogTitle>
          <DialogDescription>
            Bearer tokens for POST /api/ingest, POST /v1/logs, and POST /v1/metrics. The secret is shown once.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void onCreate(e)}>
          <DialogField label="Name">
            <DialogControl>
              <input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. vector"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </DialogControl>
          </DialogField>
          {secret ? (
            <div className="flex items-center gap-2 rounded-[4.4px] border border-white/10 bg-accent/40 px-2.5 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {secret}
              </code>
              <button
                type="button"
                className="h-6 shrink-0 rounded-[2.4px] border border-input px-[9px] text-[11px] hover:bg-accent"
                onClick={() => void onCopy()}
              >
                Copy
              </button>
            </div>
          ) : null}
          {tokens.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-white/10">
              {tokens.map((token, i) => (
                <div
                  key={token.id}
                  className={`flex items-center gap-2 px-[9px] py-1.5 ${
                    i === tokens.length - 1 ? "" : "border-b border-white/[0.08]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{token.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {new Date(token.created_at).toISOString().slice(0, 10)}
                  </span>
                  <button
                    type="button"
                    className="h-[26px] rounded-[4.4px] px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-destructive"
                    onClick={() => void onDelete(token.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <p className="text-[12px] text-muted-foreground">
            Deleting a token stops that shipper immediately.
          </p>
          <DialogFooter>
            <Button type="submit" disabled={name.trim().length === 0} className="h-8">
              Create
            </Button>
            <span className="flex-1" />
            <DialogClose type="button">Cancel</DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
