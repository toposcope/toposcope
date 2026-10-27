import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** `GET /api/me` (#305). */
export type Me = {
  id: string;
  kind: "person" | "service";
  name: string;
  email: string | null;
  role: "viewer" | "operator" | "owner";
  via: "session" | "token";
  initials: string;
  /** Owners by name, so "ask an Owner" names someone (30e). */
  owners?: string[];
};

const roleWords: Record<Me["role"], string> = { viewer: "Viewer", operator: "Operator", owner: "Owner" };

/** The person's initials at the header's right end (30a), with who they are and Sign out (30e). */
export function MeMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  async function newCodes() {
    const res = await fetch("/api/me/two-step/backup-codes", { method: "POST" });
    const body = (await res.json().catch(() => null)) as { backup_codes?: string[]; error?: string } | null;
    if (!res.ok || !body?.backup_codes) {
      toast.error(body?.error ?? `No new codes (${res.status})`);
      return;
    }
    setCodes(body.backup_codes);
  }
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[#27272a] text-[11px] font-semibold text-foreground hover:bg-[#3f3f46]"
          aria-label={`${me.name} · ${roleWords[me.role]}`}
          title={`${me.name} · ${roleWords[me.role]}`}
        >
          {me.initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[248px] p-1">
        <div className="flex flex-col gap-[3px] border-b border-white/[0.08] px-2 pt-2 pb-2.5">
          <span className="truncate text-[13px] font-semibold">{me.name}</span>
          {me.email ? <span className="truncate font-mono text-[11.5px] text-muted-foreground">{me.email}</span> : null}
          <span className="text-[11.5px] text-muted-foreground">{roleWords[me.role]}</span>
          {me.role !== "owner" && me.owners?.length ? (
            <span className="text-[11.5px] text-muted-foreground">
              {me.role === "viewer" ? "Need to change a monitor?" : "Need someone let in?"} Owners: {me.owners.join(", ")}
            </span>
          ) : null}
        </div>
        {me.via === "session" && me.kind === "person" ? (
          <DropdownMenuItem className="mt-1 h-8 text-[13px]" onSelect={() => void newCodes()}>
            New backup codes…
          </DropdownMenuItem>
        ) : null}
        {me.via === "session" ? (
          <DropdownMenuItem className="h-8 text-[13px]" onSelect={onSignOut}>
            Sign out
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
    {codes ? (
      <>
        <div className="fixed inset-0 z-30 bg-black/55" aria-hidden="true" onClick={() => setCodes(null)} />
        <section aria-label="New backup codes" className="fixed top-[80px] left-1/2 z-40 flex w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-4 rounded-[12px] border border-zinc-700 bg-[#121214] px-7 py-6">
          <h2 className="m-0 text-[17px] font-semibold">Ten new backup codes</h2>
          <span className="text-[12.5px] text-muted-foreground">Each works once, in place of the six digits. Shown now and never again; the earlier ten no longer work.</span>
          <div className="grid grid-cols-2 gap-x-7 gap-y-2.5 rounded-[10px] border border-dashed border-plate bg-[#0a0a0c] px-6 py-5 font-mono text-[16px] tracking-[0.06em]">
            {codes.map((code, i) => (
              <span key={code}>
                <i className="mr-2.5 inline-block w-[18px] text-[12px] text-zinc-600 not-italic">{i + 1}</i>
                {code}
              </span>
            ))}
          </div>
          <div className="flex gap-2.5">
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(codes.join("\n")).then(() => toast.success("Copied"))}>
              Copy all
            </Button>
            <Button type="button" onClick={() => setCodes(null)}>
              Done
            </Button>
          </div>
        </section>
      </>
    ) : null}
    </>
  );
}
