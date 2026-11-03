import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GithubBand, useGithub } from "@/components/github-band";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseRepo, parseRepoPath, repoDisplay, repoFilePath, repoHostGuessed, repoHostWords, repoResourceKey, type Repo } from "../../shared/code-links";
import type { GithubRepo, GithubState } from "../github";
import type { KnownRepo, ServiceRow } from "../repositories";
import { knownFromWords, knownRepos, servicesWords } from "../repositories";

/**
 * Settings › Repositories (#393, frame 37i; #413, frames 41a–41e): where each service's code
 * lives, so a sha and a stack frame open it. An Operator picks a repository Toposcope already
 * knows or pastes one, sets several services at once, and gives a service a folder when its
 * stack paths start in one; a Viewer reads the table. With GitHub connected (#416, 42a–42h), Set
 * also lists the repositories the Toposcope App can see.
 */
export function RepositoriesView(props: { onSettings: () => void; canWrite: boolean; canConnect: boolean }) {
  const gh = useGithub();
  const [rows, setRows] = useState<ServiceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The open popover: a row's ("change" / "pick" / "folder"), or the selection bar's ("" service).
  const [open, setOpen] = useState<{ service: string; mode: "change" | "pick" | "folder" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/repositories");
    if (!res.ok) {
      setFailed(true);
      return;
    }
    const body = (await res.json()) as { repositories: ServiceRow[] };
    setRows(body.repositories);
    setSelected((cur) => new Set([...cur].filter((s) => body.repositories.some((r) => r.service === s))));
  }, []);
  useEffect(() => {
    void load().catch(() => setFailed(true));
  }, [load]);

  async function put(service: string, body: { url: string; path?: string }): Promise<string | null> {
    const res = await fetch(`/api/repositories/${encodeURIComponent(service)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return null;
    }
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? `Save failed (${res.status})`;
  }

  async function setRepo(services: string[], url: string) {
    setBusy(true);
    try {
      const errors = (await Promise.all(services.map((s) => put(s, { url })))).filter((e): e is string => e !== null);
      const repo = parseRepo(url);
      if (errors.length) {
        toast.error(errors[0]!);
      } else {
        toast.success(services.length === 1 ? `${services[0]}'s repository saved` : `${services.length} services set to ${repo?.name ?? url}`);
        setOpen(null);
        if (services.length > 1 || open?.service === "") {
          setSelected(new Set());
        }
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setFolder(service: string, url: string, path: string) {
    setBusy(true);
    try {
      const error = await put(service, { url, path });
      if (error) {
        toast.error(error);
        return;
      }
      toast.success(path ? `${service}'s folder saved` : `${service}'s folder cleared`);
      setOpen(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function clear(services: string[]) {
    setBusy(true);
    try {
      const results = await Promise.all(services.map((s) => fetch(`/api/repositories/${encodeURIComponent(s)}`, { method: "DELETE" })));
      const bad = results.find((res) => !res.ok);
      if (bad) {
        const json = (await bad.json().catch(() => null)) as { error?: string } | null;
        toast.error(json?.error ?? `Clear failed (${bad.status})`);
      } else {
        toast.success(services.length === 1 ? `${services[0]}'s repository cleared` : `${services.length} repositories cleared`);
        setOpen(null);
        setSelected(new Set());
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const known = rows ? knownRepos(rows) : [];
  const picked = rows ? rows.filter((r) => selected.has(r.service)).map((r) => r.service) : [];
  const pickedSetHere = rows ? rows.filter((r) => selected.has(r.service) && r.repository?.from === "set").map((r) => r.service) : [];
  const allPicked = rows !== null && rows.length > 0 && picked.length === rows.length;
  const toggle = (service: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(service)) {
        next.delete(service);
      } else {
        next.add(service);
      }
      return next;
    });
  const th = "px-4 py-2.5 text-left whitespace-nowrap text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase";
  const td = "px-4 py-3 align-middle";
  const cols = props.canWrite ? 5 : 4;

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
          <p className="m-0 text-[12px] text-muted-foreground">Where each service's code lives, so a sha and a stack frame open it.</p>
        </div>
        {gh.github?.configured ? <GithubBand github={gh.github} canConnect={props.canConnect} onChange={gh.set} /> : null}
        {failed && !rows ? (
          <div className="rounded-lg border bg-card px-3 py-8 text-center">
            <p className="text-sm">Could not read the repositories.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[10px] border border-white/10 bg-[#131316]">
            {props.canWrite && picked.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2.5 border-b border-white/[0.08] bg-[#18181b] px-4 py-2 text-[12.5px]">
                <span>{picked.length} selected</span>
                <Popover open={open?.service === ""} onOpenChange={(o) => setOpen(o ? { service: "", mode: "pick" } : null)}>
                  <PopoverTrigger asChild>
                    <Button type="button" disabled={busy}>
                      Set repository ▾
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[420px] p-1">
                    <RepoMenu services={picked} known={known} github={gh.github} busy={busy} onPick={(url) => void setRepo(picked, url)} />
                  </PopoverContent>
                </Popover>
                <Button type="button" variant="outline" disabled={busy || pickedSetHere.length === 0} title={pickedSetHere.length === 0 ? "None of these is set here" : undefined} onClick={() => void clear(pickedSetHere)}>
                  Clear
                </Button>
                <span className="flex-1" />
                <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => setSelected(new Set())}>
                  Cancel
                </Button>
              </div>
            ) : null}
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {props.canWrite ? (
                    <th className="w-4 py-2.5 pr-0 pl-4 text-left">
                      <input type="checkbox" aria-label="Select all services" className="accent-[#e7e1d3]" checked={allPicked} disabled={!rows?.length} onChange={() => setSelected(allPicked || !rows ? new Set() : new Set(rows.map((r) => r.service)))} />
                    </th>
                  ) : null}
                  <th className={th}>Service</th>
                  <th className={th}>Repository</th>
                  <th className={th}>Known from</th>
                  <th className={th} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr>
                    <td colSpan={cols} className={`${td} text-muted-foreground`}>
                      reading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={cols} className={`${td} text-muted-foreground`}>
                      No service has sent a row in the last 7 days.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const repo = r.repository;
                    const rowOpen = open?.service === r.service ? open : null;
                    return (
                      <tr key={r.service} className={`border-b border-white/[0.06] ${selected.has(r.service) ? "bg-[#e7e1d3]/[0.05]" : rowOpen ? "bg-white/[0.03]" : ""}`}>
                        <Popover open={rowOpen !== null} onOpenChange={(o) => setOpen(o ? { service: r.service, mode: repo?.from === "set" ? "change" : "pick" } : null)}>
                          {props.canWrite ? (
                            <td className="w-4 py-3 pr-0 pl-4 align-middle">
                              <input type="checkbox" aria-label={`Select ${r.service}`} className="accent-[#e7e1d3]" checked={selected.has(r.service)} onChange={() => toggle(r.service)} />
                            </td>
                          ) : null}
                          <td className={`${td} font-mono`}>{r.service}</td>
                          <td className={`${td} font-mono ${repo ? "" : "text-muted-foreground"}`}>
                            {repo ? repoDisplay(repo) : "none"}
                            {repo?.path ? <span className="text-muted-foreground"> · {repo.path}</span> : null}
                            {repo && repoHostGuessed(repo) ? <span className="font-sans text-[12px] text-muted-foreground"> · links as {repoHostWords[repo.host]}</span> : null}
                          </td>
                          <td className={`${td} whitespace-nowrap text-muted-foreground`} title={r.set_at ? new Date(r.set_at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : undefined}>
                            {knownFromWords(r)}
                          </td>
                          <td className={`${td} text-right`}>
                            {props.canWrite ? (
                              <PopoverTrigger asChild>
                                <Button type="button" variant="outline" disabled={busy} aria-haspopup="menu">
                                  {repo?.from === "set" ? "Change" : "Set"}
                                </Button>
                              </PopoverTrigger>
                            ) : null}
                          </td>
                          <PopoverContent align="end" className={rowOpen?.mode === "change" ? "w-[200px] p-1" : rowOpen?.mode === "folder" ? "w-[440px] p-3" : "w-[420px] p-1"}>
                            {rowOpen?.mode === "change" && repo ? (
                              <div role="menu" aria-label={`Change ${r.service}'s repository`} className="flex flex-col">
                                <MenuItem onClick={() => setOpen({ service: r.service, mode: "pick" })}>Repository…</MenuItem>
                                <MenuItem onClick={() => setOpen({ service: r.service, mode: "folder" })}>Folder…</MenuItem>
                                <MenuItem disabled={busy} onClick={() => void clear([r.service])}>
                                  Clear
                                </MenuItem>
                              </div>
                            ) : rowOpen?.mode === "folder" && repo ? (
                              <FolderForm service={r.service} repo={repo} busy={busy} onCancel={() => setOpen(null)} onSave={(path) => void setFolder(r.service, repo.url, path)} />
                            ) : (
                              <RepoMenu services={[r.service]} known={known} github={gh.github} busy={busy} onPick={(url) => void setRepo([r.service], url)} />
                            )}
                          </PopoverContent>
                        </Popover>
                      </tr>
                    );
                  })
                )}
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

function MenuItem(props: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" disabled={props.disabled} onClick={props.onClick} className="w-full rounded-[4.4px] px-2 py-[7px] text-left text-[12.5px] hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:opacity-50">
      {props.children}
    </button>
  );
}

/** The repositories the Toposcope App can see that match `q`, read as `q` settles. */
function useGithubRepos(on: boolean, q: string): { repos: GithubRepo[]; matching: number; total: number } | null {
  const [found, setFound] = useState<{ repos: GithubRepo[]; matching: number; total: number } | null>(null);
  useEffect(() => {
    if (!on) {
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void fetch(`/api/github/repositories?q=${encodeURIComponent(q.trim())}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json: { repositories: GithubRepo[]; matching: number; total: number } | null) => {
          if (live && json) {
            setFound({ repos: json.repositories, matching: json.matching, total: json.total });
          }
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [on, q]);
  return on ? found : null;
}

const sectionHead = "px-2 pt-2 pb-0.5 text-[10.5px] tracking-[0.04em] text-muted-foreground uppercase";
const repoItem =
  "grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2.5 rounded-[4.4px] px-2 py-[7px] text-left text-[12.5px] hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:opacity-50";

/**
 * 41b / 41c / 42e: the repositories used here, each with its services; with GitHub connected, a
 * search and the repositories the App can see; then Paste a URL….
 */
function RepoMenu(props: { services: string[]; known: KnownRepo[]; github: GithubState | null; busy: boolean; onPick: (url: string) => void }) {
  const ghOn = props.github?.state === "on" && (props.github.repositories ?? 0) > 0;
  const [paste, setPaste] = useState(props.known.length === 0 && !ghOn);
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");
  const found = useGithubRepos(ghOn && !paste, q);
  const typed = url.trim() ? parseRepo(url) : null;
  const forWords = <span className="font-mono text-zinc-300">{servicesWords(props.services)}</span>;
  const needle = q.trim().toLowerCase();
  const usedHere = needle ? props.known.filter((k) => k.repo.name.toLowerCase().includes(needle) || repoDisplay(k.repo).toLowerCase().includes(needle)) : props.known;
  const usedUrls = new Set(props.known.map((k) => k.repo.url.toLowerCase()));
  const onGithub = (found?.repos ?? []).filter((repo) => !usedUrls.has(repo.url.toLowerCase()));

  if (paste) {
    return (
      <form
        aria-label={`Paste a repository URL for ${servicesWords(props.services)}`}
        className="flex flex-col gap-2 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed) {
            props.onPick(url.trim());
          }
        }}
      >
        {props.known.length > 0 || ghOn ? (
          <button type="button" className="self-start text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setPaste(false)}>
            ‹ {ghOn ? "Repositories" : "Known repositories"}
          </button>
        ) : null}
        <label htmlFor="repo-url" className="text-[12px] text-muted-foreground">
          Repository URL for {forWords}
        </label>
        <input
          id="repo-url"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://git.example.com/owner/name"
          className="h-[30px] w-full min-w-0 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[12px] outline-none focus:border-[#e7e1d3]"
        />
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="min-w-0 truncate">
            {typed ? (
              <>
                Links as {repoHostWords[typed.host]} · <span className="font-mono text-zinc-300">{repoDisplay(typed)}</span>
              </>
            ) : url.trim() ? (
              "Not a repository URL"
            ) : null}
          </span>
          <span className="flex-1" />
          <Button type="submit" disabled={!typed || props.busy}>
            Save
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div role="menu" aria-label={`Set a repository for ${servicesWords(props.services)}`} className="flex flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">For {forWords}</div>
      {ghOn ? (
        <div className="p-1">
          <input
            aria-label="Find a repository"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a repository"
            className="h-7 w-full min-w-0 rounded-[6px] border border-white/10 bg-[#0d0d0f] px-2 font-mono text-[12px] outline-none focus:border-[#e7e1d3]"
          />
        </div>
      ) : null}
      {ghOn && usedHere.length > 0 ? <div className={sectionHead}>Used here</div> : null}
      {usedHere.map((k) => (
        <button key={k.repo.url} type="button" role="menuitem" disabled={props.busy} onClick={() => props.onPick(k.repo.url)} className={repoItem}>
          <span className="truncate font-mono">{repoDisplay(k.repo)}</span>
          <span className="text-[11.5px] text-muted-foreground">{servicesWords(k.services)}</span>
        </button>
      ))}
      {ghOn ? (
        <>
          <div className={sectionHead}>{found ? `On GitHub · ${onGithub.length} of ${found.total}` : "On GitHub · reading…"}</div>
          <div className="max-h-[240px] overflow-y-auto">
            {onGithub.map((repo) => (
              <button key={repo.url} type="button" role="menuitem" disabled={props.busy} onClick={() => props.onPick(repo.url)} className={repoItem}>
                <span className="truncate font-mono">{repoDisplay({ url: repo.url, host: "github", name: repo.name })}</span>
                <span className="text-[11.5px] text-muted-foreground">
                  {repo.owner}
                  {repo.private ? " · private" : ""}
                </span>
              </button>
            ))}
            {found && onGithub.length === 0 ? <div className="px-2 py-[7px] text-[12px] text-muted-foreground">{q.trim() ? `No repository matches ${q.trim()}` : "Every one is used here"}</div> : null}
          </div>
        </>
      ) : null}
      <div className="my-1 h-px bg-white/[0.08]" />
      <div className="flex items-center justify-between gap-2">
        <MenuItem onClick={() => setPaste(true)}>Paste a URL…</MenuItem>
        {ghOn && props.github ? (
          <a href={props.github.install_url} target="_blank" rel="noreferrer noopener" className="shrink-0 px-2 py-[7px] text-[11.5px] whitespace-nowrap text-muted-foreground hover:text-foreground">
            Not listed? Choose repositories ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** 41e: the folder a service's stack paths start in, with a frame it would open. */
function FolderForm(props: { service: string; repo: Repo & { path: string | null }; busy: boolean; onCancel: () => void; onSave: (path: string) => void }) {
  const [text, setText] = useState(props.repo.path ?? "");
  const folder = parseRepoPath(text);
  const example = "src/index.ts";
  return (
    <form
      aria-label={`Folder for ${props.service}`}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (folder !== null) {
          props.onSave(folder);
        }
      }}
    >
      <label htmlFor="repo-folder" className="text-[12px] text-muted-foreground">
        Folder for <span className="font-mono text-foreground">{props.service}</span> in <span className="font-mono text-foreground">{props.repo.name}</span>
      </label>
      <input
        id="repo-folder"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="services/pay"
        className="h-[30px] w-full min-w-0 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 font-mono text-[12px] outline-none focus:border-[#e7e1d3]"
      />
      <p className="m-0 text-[12px] leading-normal text-muted-foreground">
        {folder === null ? (
          "Not a folder in the repository."
        ) : folder ? (
          <>
            A stack frame <span className="font-mono text-zinc-300">{example}:41</span> opens <span className="font-mono text-foreground">{repoFilePath({ ...props.repo, path: folder }, example)}</span> line 41.
          </>
        ) : (
          <>
            A stack frame <span className="font-mono text-zinc-300">{example}:41</span> opens <span className="font-mono text-foreground">{example}</span> line 41, at the root.
          </>
        )}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={folder === null || props.busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
