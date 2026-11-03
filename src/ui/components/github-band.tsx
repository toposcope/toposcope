import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { GithubState } from "../github";
import { githubStatusWords } from "../github";

/** The band's state from `GET /api/github`; null while reading. Polls while a code waits. */
export function useGithub(): { github: GithubState | null; reload: (fresh?: boolean) => Promise<void>; set: (g: GithubState) => void } {
  const [github, setGithub] = useState<GithubState | null>(null);
  const reload = useCallback(async (fresh = false) => {
    const res = await fetch(`/api/github${fresh ? "?fresh=1" : ""}`);
    if (res.ok) {
      setGithub((await res.json()) as GithubState);
    }
  }, []);
  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);
  const connecting = github?.state === "connecting";
  useEffect(() => {
    if (!connecting) {
      return;
    }
    const t = setInterval(() => void reload().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [connecting, reload]);
  // Back from Choose repositories or Install on GitHub: read the list again.
  useEffect(() => {
    const onFocus = () => void reload(true).catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  return { github, reload, set: setGithub };
}

function GithubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

const external = "inline-flex h-7 items-center rounded-lg border border-white/15 px-2.5 text-sm text-foreground no-underline hover:bg-white/[0.06]";

/**
 * The GitHub band above Repositories (#416, frames 42a–42h): connect with a device code, the
 * accounts and repositories the App can see, disconnect. Only an Owner gets the buttons; it is
 * not drawn at all in a build with no App client ID.
 */
export function GithubBand(props: { github: GithubState; canConnect: boolean; onChange: (g: GithubState) => void }) {
  const g = props.github;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (g.state !== "connecting") {
      return;
    }
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [g.state]);

  async function call(method: "POST" | "DELETE", path: string) {
    setBusy(true);
    try {
      const res = await fetch(path, { method });
      const json = (await res.json().catch(() => null)) as (GithubState & { error?: string }) | null;
      if (!res.ok || !json) {
        toast.error(json?.error ?? `GitHub failed (${res.status})`);
        return;
      }
      props.onChange(json);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  const noRepos = g.state === "on" && g.repositories === 0;
  const warn = g.state === "ended" || noRepos;
  const left = g.code ? Math.max(0, Math.round((g.code.expires_at - now) / 1000)) : 0;
  return (
    <section aria-label="GitHub" className={`mb-3.5 flex flex-col gap-2.5 rounded-xl border bg-surface-2 px-4 py-3 text-sm ${warn ? "border-plate/35" : "border-white/10"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <GithubMark />
        <span className="font-medium">GitHub</span>
        <span className={g.state === "ended" ? "text-foreground" : "text-muted-foreground"}>{githubStatusWords(g, props.canConnect)}</span>
        <span className="flex-1" />
        {props.canConnect && !confirm ? (
          g.state === "off" || g.state === "ended" ? (
            <Button type="button" disabled={busy} onClick={() => void call("POST", "/api/github/connect")}>
              {g.state === "ended" ? "Connect again" : "Connect GitHub"}
            </Button>
          ) : g.state === "connecting" ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void call("DELETE", "/api/github/connect")}>
              Cancel
            </Button>
          ) : (
            <>
              <a href={g.install_url} target="_blank" rel="noreferrer noopener" className={external}>
                {noRepos ? "Install on an account ↗" : "Choose repositories ↗"}
              </a>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            </>
          )
        ) : null}
      </div>
      {g.state === "connecting" && g.code ? (
        <div className="flex flex-wrap items-center gap-[18px] rounded-lg border border-white/[0.08] bg-surface-1 px-3.5 py-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">
              On{" "}
              <a href={g.code.verification_uri} target="_blank" rel="noreferrer noopener" className="text-foreground underline decoration-white/40 underline-offset-2">
                {g.code.verification_uri.replace(/^https?:\/\//, "")}
              </a>
              , enter
            </span>
            <span className="font-mono text-xl tracking-[0.12em]">{g.code.user_code}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(g.code!.user_code).then(() => toast.success("Code copied"));
            }}
          >
            Copy code
          </Button>
          <span className="flex-1" />
          <span className="text-muted-foreground">
            Waiting for GitHub · code ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </span>
        </div>
      ) : null}
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-plate/35 bg-surface-1 px-3.5 py-2.5">
          <span>Disconnect GitHub? Repositories set here stay; Set stops listing GitHub's.</span>
          <span className="flex-1" />
          <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void call("DELETE", "/api/github")}>
            Disconnect
          </Button>
        </div>
      ) : null}
    </section>
  );
}
