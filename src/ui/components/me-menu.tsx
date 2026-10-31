import { useEffect, useState } from "react";
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
  /** 34e: this session skipped the code on a remembered browser, until when. */
  remembered?: { until: number; signed_in_at: number } | null;
};

type RememberedBrowser = { id: string; label: string; days: number; created_at: number; last_used_at: number | null; expires_at: number; this_browser: boolean };

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sun 8 Nov", in UTC like the sign-in page that promised it. */
export function dayAt(ms: number): string {
  const d = new Date(ms);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
function stampAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

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
  const [browsers, setBrowsers] = useState<RememberedBrowser[] | null>(null);
  const [count, setCount] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  async function loadBrowsers(open: boolean) {
    const res = await fetch("/api/me/remembered-browsers");
    const body = (await res.json().catch(() => null)) as { browsers?: RememberedBrowser[] } | null;
    const list = body?.browsers ?? [];
    setCount(list.length);
    if (open) {
      setBrowsers(list);
    }
  }
  async function forget(id: string | null) {
    const res = await fetch(id ? `/api/me/remembered-browsers/${encodeURIComponent(id)}` : "/api/me/remembered-browsers", { method: "DELETE" });
    setArmed(null);
    if (!res.ok) {
      toast.error(`Not forgotten (${res.status})`);
      return;
    }
    toast.success(id ? "Forgotten: it asks for the code at its next sign-in" : "Every browser forgotten");
    await loadBrowsers(true);
  }
  // 34e: say once per sign-in why no code was asked.
  useEffect(() => {
    if (!me.remembered) {
      return;
    }
    const key = `toposcope.remembered-toast.${me.id}`;
    const seen = (() => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    })();
    if (seen === String(me.remembered.signed_in_at)) {
      return;
    }
    try {
      localStorage.setItem(key, String(me.remembered.signed_in_at));
    } catch {
      // A private window: the toast may show again.
    }
    toast.success(`No code asked: this browser is remembered for your two-step until ${dayAt(me.remembered.until)}.`, { description: "Forget it from your menu › Remembered browsers." });
  }, [me.id, me.remembered]);
  const twoStepMenu = me.via === "session" && me.kind === "person";
  return (
    <>
    <DropdownMenu onOpenChange={(open) => (open && twoStepMenu ? void loadBrowsers(false) : undefined)}>
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
        {twoStepMenu && count > 0 ? (
          <DropdownMenuItem className="h-8 justify-between text-[13px]" onSelect={() => void loadBrowsers(true)}>
            Remembered browsers…
            <span className="font-mono text-[11.5px] text-muted-foreground">{count}</span>
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
    {browsers ? (
      <>
        <div className="fixed inset-0 z-30 bg-black/55" aria-hidden="true" onClick={() => setBrowsers(null)} />
        <section aria-label="Remembered browsers" className="fixed top-[80px] left-1/2 z-40 flex w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-4 rounded-[12px] border border-zinc-700 bg-[#121214] px-7 py-6">
          <h2 className="m-0 text-[17px] font-semibold">Remembered browsers</h2>
          <span className="text-[12.5px] leading-[1.55] text-muted-foreground">After your password, these skip the six digits until the day shown. Forgetting one asks for a code there at its next sign-in; it stays signed in until then.</span>
          {browsers.length === 0 ? (
            <span className="text-[12.5px] text-muted-foreground">No browser is remembered. Tick Remember this browser after the six digits to add one.</span>
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-white/10">
              {browsers.map((b, i) => (
                <div key={b.id} className={`grid grid-cols-[minmax(0,1fr)_140px_auto] items-center gap-3 px-3.5 py-2.5 text-[12.5px] ${i ? "border-t border-white/[0.06]" : ""}`}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">
                      {b.label}
                      {b.this_browser ? <span className="font-normal text-muted-foreground"> · this browser</span> : null}
                    </span>
                    <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                      remembered {stampAt(b.created_at)} · {b.last_used_at ? `last used ${stampAt(b.last_used_at)}` : `${b.days} ${b.days === 1 ? "day" : "days"}`}
                    </span>
                  </span>
                  <span className="font-mono text-[12px] text-zinc-300">until {dayAt(b.expires_at)}</span>
                  {armed === b.id ? (
                    <button type="button" className="text-right text-[12px] text-plate underline" onClick={() => void forget(b.id)}>
                      sure? forget
                    </button>
                  ) : (
                    <button type="button" className="text-right text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setArmed(b.id)}>
                      forget
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3.5">
            {browsers.length > 1 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => (armed === "all" ? void forget(null) : setArmed("all"))}>
                {armed === "all" ? `Sure? forget all ${browsers.length}` : `Forget all ${browsers.length}`}
              </Button>
            ) : null}
            <span className="text-[12px] text-muted-foreground">Resetting two-step or changing your password forgets them all.</span>
            <Button type="button" size="sm" className="ml-auto" onClick={() => setBrowsers(null)}>
              Done
            </Button>
          </div>
        </section>
      </>
    ) : null}
    </>
  );
}
