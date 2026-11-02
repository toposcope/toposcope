import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { parseRepo, repoDisplay, repoHostWords, repoResourceKey } from "../../shared/code-links";
import type { ServiceRow } from "../repositories";
import { knownFromWords, pickHandService } from "../repositories";

/**
 * Settings › Repositories (#393, frame 37i): where each service's code lives, so a sha and a
 * stack frame open it. An Operator sets one by hand or clears it; a Viewer reads the table.
 */
export function RepositoriesView(props: { onSettings: () => void; canWrite: boolean }) {
  const [rows, setRows] = useState<ServiceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [service, setService] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/repositories");
    if (!res.ok) {
      setFailed(true);
      return;
    }
    const body = (await res.json()) as { repositories: ServiceRow[] };
    setRows(body.repositories);
    setService((cur) => pickHandService(body.repositories, cur));
  }, []);
  useEffect(() => {
    void load().catch(() => setFailed(true));
  }, [load]);

  async function save() {
    if (!service) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(service)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(json?.error ?? `Save failed (${res.status})`);
        return;
      }
      toast.success(`${service}'s repository saved`);
      setUrl("");
      setService(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function clear(name: string) {
    const res = await fetch(`/api/repositories/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Clear failed (${res.status})`);
      return;
    }
    toast.success(`${name}'s repository cleared`);
    await load();
  }

  const typed = url.trim() ? parseRepo(url) : null;
  const th = "px-4 py-2.5 text-left whitespace-nowrap text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase";
  const td = "px-4 py-3 align-middle";

  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pt-[22px] pb-6">
      <div className="mx-auto w-full max-w-[980px]">
        <nav aria-label="Breadcrumb" className="-mt-2.5 mb-1.5 flex items-center gap-2 text-[13px]">
          <button type="button" className="text-[#8a8a93] hover:text-foreground" onClick={props.onSettings}>
            Settings
          </button>
          <span className="text-[#3f3f46]">›</span>
          <span className="font-medium text-foreground" aria-current="page">
            Repositories
          </span>
        </nav>
        <div className="mb-3.5 flex flex-wrap items-baseline gap-3.5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Repositories</h1>
          <p className="m-0 text-[12px] text-muted-foreground">Where each service's code lives, so a sha and a stack frame open it. Links only: nothing is fetched, no token is kept.</p>
        </div>
        {failed && !rows ? (
          <div className="rounded-lg border bg-card px-3 py-8 text-center">
            <p className="text-sm">Could not read the repositories.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-white/10 bg-[#131316]">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className={th}>Service</th>
                  <th className={th}>Repository</th>
                  <th className={th}>Known from</th>
                  <th className={th}>Links as</th>
                  <th className={th} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr>
                    <td colSpan={5} className={`${td} text-muted-foreground`}>
                      reading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={`${td} text-muted-foreground`}>
                      No service has sent a row in the last 7 days.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.service} className="border-b border-white/[0.06]">
                      <td className={`${td} font-mono`}>{r.service}</td>
                      <td className={`${td} font-mono ${r.repository ? "" : "text-muted-foreground"}`}>{r.repository ? repoDisplay(r.repository) : "none"}</td>
                      <td className={`${td} whitespace-nowrap text-muted-foreground`} title={r.set_at ? new Date(r.set_at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : undefined}>
                        {knownFromWords(r)}
                      </td>
                      <td className={`${td} whitespace-nowrap text-muted-foreground`}>{r.repository ? repoHostWords[r.repository.host] : "—"}</td>
                      <td className={`${td} text-right`}>
                        {!props.canWrite ? null : r.repository?.from === "set" ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => void clear(r.service)}>
                            Clear
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setService(r.service);
                              input.current?.focus();
                            }}
                          >
                            Set
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
                {props.canWrite && service ? (
                  <tr>
                    <td className={`${td} text-muted-foreground`}>Set one by hand</td>
                    <td className={td}>
                      <input
                        ref={input}
                        aria-label={`Repository for ${service}`}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && typed) {
                            void save();
                          }
                        }}
                        placeholder="https://git.example.com/owner/name"
                        className="h-8 w-full min-w-0 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[12.5px] outline-none"
                      />
                    </td>
                    <td className={`${td} text-muted-foreground`}>
                      for <span className="font-mono text-foreground">{service}</span>
                    </td>
                    <td className={`${td} whitespace-nowrap text-muted-foreground`}>{typed ? repoHostWords[typed.host] : "—"}</td>
                    <td className={`${td} text-right`}>
                      <Button type="button" size="sm" disabled={!typed || busy} onClick={() => void save()}>
                        Save
                      </Button>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 mb-0 text-[12px] leading-[1.6] text-muted-foreground">
          A service's repository comes from <span className="font-mono text-zinc-200">{repoResourceKey}</span> on its resource, else <span className="font-mono text-zinc-200">repo</span> on its newest deploy mark, else this page. One set here wins over both. The link shape follows the host: GitHub, GitLab, Gitea / Forgejo, Bitbucket.
          {props.canWrite ? "" : " Only an Operator sets or clears one."}
        </p>
      </div>
    </main>
  );
}
